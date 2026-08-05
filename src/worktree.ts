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
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
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

export function createNodeWorktree(run: WorktreeRunState, runId: string, nodeId: string, attempt: number, originalCwd: string, baseCommit = run.baseCommit): WorktreeState {
  const relativeCwd = path.relative(run.repoRoot, fs.realpathSync(originalCwd));
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) throw new Error(`Task cwd escapes repository: ${originalCwd}`);
  const key = `${safe(runId)}-${safe(nodeId)}-${attempt}`;
  const worktreePath = path.join(os.tmpdir(), `pi-mesh-${key}`);
  const branch = `pi-mesh/${safe(runId)}/${safe(nodeId)}-${attempt}`;
  git(run.repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  if (run.setupHook) {
    const setup = spawnSync(run.setupHook, { cwd: worktreePath, encoding: "utf8", timeout: 120_000, shell: false });
    if (setup.status !== 0) {
      try { git(run.repoRoot, ["worktree", "remove", "--force", worktreePath]); } catch {}
      throw new Error(setup.stderr.trim() || setup.stdout.trim() || `worktree setup hook failed with ${setup.status}`);
    }
  }
  return {
    repoRoot: run.repoRoot,
    baseCommit,
    path: worktreePath,
    cwd: relativeCwd ? path.join(worktreePath, relativeCwd) : worktreePath,
    branch,
    attempt,
    cleanupStatus: "pending",
    phase: "ready",
  };
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

export function finalizeNodeWorktree(cwd: string, runId: string, nodeId: string, state: WorktreeState, status: string, summary?: string): WorktreeState {
  try {
    const dirty = git(state.path, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
    if (dirty) {
      git(state.path, ["add", "-A"]);
      git(state.path, ["-c", "user.name=pi-mesh", "-c", "user.email=pi-mesh@local", "commit", "--no-verify", "-m", `pi-mesh: ${nodeId}`]);
    }
    const finalCommit = git(state.path, ["rev-parse", "HEAD"]).trim();
    const changed = finalCommit !== state.baseCommit;
    if (!changed) {
      git(state.repoRoot, ["worktree", "remove", "--force", state.path]);
      return { ...state, finalCommit, cleanupStatus: "complete", phase: "removed", filesChanged: 0, insertions: 0, deletions: 0 };
    }

    const artifactDir = path.join(meshDir(cwd), "artifacts", runId, nodeId, `attempt-${state.attempt}`);
    fs.mkdirSync(artifactDir, { recursive: true });
    const patchPath = path.join(artifactDir, "changes.patch");
    const handoffPath = path.join(artifactDir, "handoff.json");
    fs.writeFileSync(patchPath, git(state.path, ["diff", "--binary", state.baseCommit, finalCommit]), { mode: 0o600 });
    const stats = counts(git(state.path, ["diff", "--numstat", state.baseCommit, finalCommit]));
    git(state.repoRoot, ["branch", "-f", state.branch, finalCommit]);
    atomicWrite(handoffPath, { schema: "pi-mesh.handoff/v1", runId, nodeId, attempt: state.attempt, status, repoRoot: state.repoRoot, baseCommit: state.baseCommit, finalCommit, branch: state.branch, patchPath, ...stats, summary: summary ?? "" });
    git(state.repoRoot, ["worktree", "remove", "--force", state.path]);
    return { ...state, finalCommit, patchPath, handoffPath, ...stats, cleanupStatus: "complete", phase: "removed" };
  } catch (error) {
    return { ...state, cleanupStatus: "partial", phase: "partial", cleanupError: error instanceof Error ? error.message : String(error) };
  }
}
