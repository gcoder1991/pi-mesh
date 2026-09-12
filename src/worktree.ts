import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWrite, meshDir } from "./store.ts";

export interface WorktreeRunState {
  repoRoot: string;
  baseCommit: string;
  setupHook?: string;
}

export interface WorktreeState {
  repoRoot: string;
  baseCommit: string;
  handoffBaseCommit?: string;
  path: string;
  cwd: string;
  branch: string;
  attempt: number;
  cleanupStatus: "pending" | "complete" | "partial";
  phase: "ready" | "running" | "captured" | "removed" | "partial";
  finalCommit?: string;
  patchPath?: string;
  handoffPath?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  cleanupError?: string;
}

function git(cwd: string, args: string[]): string {
  // Internal evidence capture is not authorization to run project hooks or
  // fsmonitor commands. Command-local overrides do not modify Git config;
  // os.devNull is a non-directory on Unix and Windows, so no hook can be found.
  const result = spawnSync("git", ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.trim().slice(0, 4096) || result.stdout.trim().slice(0, 4096) || `git ${args.join(" ")} failed`);
  return result.stdout;
}

/** Stream binary patches directly to disk; spawnSync's default stdout buffer
 * must not turn a large, valid handoff into a truncated artifact. */
function gitPatch(cwd: string, base: string, final: string, file: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    const result = spawnSync("git", ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--binary", base, final], { stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim().slice(0, 4096) || "git patch capture failed");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temp, file);
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed before rename */ }
    fs.rmSync(temp, { force: true });
  }
}

function repoRoot(cwd: string): string {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") throw new Error("worktree isolation requires a git repository");
  return fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

export function prepareWorktreeRun(cwd: string, taskCwds: string[], setupHook?: string): WorktreeRunState {
  const root = repoRoot(cwd);
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()) {
    throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
  }
  const baseCommit = git(root, ["rev-parse", "HEAD"]).trim();
  for (const taskCwd of taskCwds) {
    if (repoRoot(taskCwd) !== root) throw new Error(`worktree task cwd must belong to ${root}: ${taskCwd}`);
  }
  let hookPath: string | undefined;
  if (setupHook) {
    hookPath = fs.realpathSync(path.resolve(cwd, setupHook));
    const relative = path.relative(root, hookPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`worktree setup hook must be inside repository: ${setupHook}`);
    if (!fs.statSync(hookPath).isFile()) throw new Error(`worktree setup hook is not a file: ${setupHook}`);
  }
  return { repoRoot: root, baseCommit, setupHook: hookPath };
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function createNodeWorktree(run: WorktreeRunState, runId: string, nodeId: string, attempt: number, originalCwd: string, baseCommit = run.baseCommit, handoffBaseCommit = baseCommit): WorktreeState {
  const relativeCwd = path.relative(run.repoRoot, fs.realpathSync(originalCwd));
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) throw new Error(`Task cwd escapes repository: ${originalCwd}`);
  const key = `${safe(runId)}-${safe(nodeId)}-${attempt}`;
  const worktreePath = path.join(os.tmpdir(), `pi-mesh-${key}`);
  const branch = `pi-mesh/${safe(runId)}/${safe(nodeId)}-${attempt}`;
  git(run.repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  const state: WorktreeState = {
    repoRoot: run.repoRoot, baseCommit, handoffBaseCommit, path: worktreePath,
    cwd: relativeCwd ? path.join(worktreePath, relativeCwd) : worktreePath,
    branch, attempt, cleanupStatus: "pending", phase: "ready",
  };
  if (run.setupHook) {
    const setup = spawnSync(run.setupHook, { cwd: worktreePath, encoding: "utf8", timeout: 120_000, shell: false });
    if (setup.status !== 0) throw new WorktreeSetupError(state, setup.stderr?.trim() || setup.stdout?.trim() || `worktree setup hook failed with ${setup.status}`);
  }
  return state;
}

export class WorktreeSetupError extends Error {
  readonly state: WorktreeState;
  constructor(state: WorktreeState, message: string) {
    super(`${message}. Setup worktree preserved at ${state.path}; inspect it before retrying.`);
    this.state = state;
  }
}

function counts(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0, insertions = 0, deletions = 0;
  for (const line of numstat.trim().split("\n")) {
    if (!line) continue;
    const [added, removed] = line.split("\t");
    filesChanged++;
    if (/^\d+$/.test(added ?? "")) insertions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }
  return { filesChanged, insertions, deletions };
}

/** Validate saved evidence against this node's retained branch, not arbitrary commits. */
export function retryWorktreeCommit(run: WorktreeRunState, runId: string, nodeId: string, state: WorktreeState): string {
  if (state.repoRoot !== run.repoRoot || state.branch !== `pi-mesh/${safe(runId)}/${safe(nodeId)}-${state.attempt}` || !state.finalCommit || !state.handoffPath) throw new Error("Previous worktree has no valid owned handoff; preserve it and repair before retrying");
  const commit = git(run.repoRoot, ["rev-parse", state.finalCommit === (state.handoffBaseCommit ?? state.baseCommit) ? `${state.finalCommit}^{commit}` : `refs/heads/${state.branch}^{commit}`]).trim();
  if (commit !== state.finalCommit) throw new Error("Previous worktree branch no longer matches saved commit");
  git(run.repoRoot, ["merge-base", "--is-ancestor", state.handoffBaseCommit ?? state.baseCommit, commit]);
  return commit;
}

/** Capture first; callers may defer removal until their checkpoint is durable. */
export function finalizeNodeWorktree(cwd: string, runId: string, nodeId: string, state: WorktreeState, status: string, summary?: string, remove = true): WorktreeState {
  let captured = state;
  try {
    const dirty = git(state.path, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
    if (dirty) {
      git(state.path, ["add", "-A"]);
      git(state.path, ["-c", "user.name=pi-mesh", "-c", "user.email=pi-mesh@local", "commit", "--no-verify", "-m", `pi-mesh: ${nodeId}`]);
    }
    const finalCommit = git(state.path, ["rev-parse", "HEAD"]).trim();
    const baseCommit = state.handoffBaseCommit ?? state.baseCommit;
    const artifactDir = path.join(meshDir(cwd), "artifacts", runId, nodeId, `attempt-${state.attempt}`);
    fs.mkdirSync(artifactDir, { recursive: true });
    const patchPath = path.join(artifactDir, "changes.patch");
    const handoffPath = path.join(artifactDir, "handoff.json");
    gitPatch(state.path, baseCommit, finalCommit, patchPath);
    const stats = counts(git(state.path, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", baseCommit, finalCommit]));
    if (finalCommit !== baseCommit) git(state.repoRoot, ["branch", "-f", state.branch, finalCommit]);
    atomicWrite(handoffPath, { schema: "pi-mesh.handoff/v1", runId, nodeId, attempt: state.attempt, status, repoRoot: state.repoRoot, baseCommit, checkoutBaseCommit: state.baseCommit, finalCommit, commitRange: `${baseCommit}..${finalCommit}`, branch: state.branch, patchPath, ...stats, summary: summary ?? "" });
    captured = { ...state, finalCommit, patchPath, handoffPath, ...stats, cleanupStatus: "pending", phase: "captured", cleanupError: undefined };
  } catch (error) {
    return { ...captured, cleanupStatus: "partial", phase: "partial", cleanupError: error instanceof Error ? error.message : String(error) };
  }
  return remove ? cleanupNodeWorktree(captured) : captured;
}

export function cleanupNodeWorktree(state: WorktreeState): WorktreeState {
  if (state.phase !== "captured") return state;
  try {
    git(state.repoRoot, ["worktree", "remove", "--force", state.path]);
    return { ...state, cleanupStatus: "complete", phase: "removed", cleanupError: undefined };
  } catch (error) {
    // A valid handoff remains delivery success; removal is only a warning.
    return { ...state, cleanupStatus: "partial", cleanupError: `Cleanup warning: ${String(error)}` };
  }
}
