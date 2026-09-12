import * as path from "node:path";
import type { MeshRun } from "./manager.ts";
import type { Usage } from "./runtime-utils.ts";

export const CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;
export const INLINE_EVIDENCE_MAX_BYTES = 32 * 1024;
/** Exactly the representation written by atomicWriteCheckpoint, including JSON
 * escaping, indentation and newline. Raw task UTF-8 length is not this budget. */
export const serializedBytes = (value: unknown): number => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
export function assertRunAdmission(run: MeshRun): void {
  // Reserve future per-node evidence, session/artifact paths and worktree state,
  // plus 2MiB for run counters/metadata. Full tasks remain in the checkpoint.
  const core = { ...run, nodes: run.nodes.map(({ output, error, activity, worktreeHistory, worktree, ...node }) => node) };
  if (serializedBytes(core) + run.nodes.length * 96 * 1024 > CHECKPOINT_MAX_BYTES - 2 * 1024 * 1024)
    throw new Error("Mesh serialized checkpoint budget exceeded; reduce task size/node count before admission or growth");
}

const object = (v: any): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const integer = (v: any, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: any, max = 4096) => typeof v === "string" && v.length <= max;
const number = (v: any) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const sources = ["user", "unknown", "operator", "failfast", "race", "timeout", "shutdown"];
export function validUsage(v: unknown): v is Usage {
  return object(v) && ["input", "output", "cacheRead", "cacheWrite", "turns"].every((k) => integer(v[k])) && number(v.cost)
    && ["costInput", "costOutput", "costCacheRead", "costCacheWrite"].every((k) => v[k] === undefined || number(v[k]));
}
function optional(v: Record<string, any>): boolean {
  return ["createdAt", "updatedAt", "startedAt", "finishedAt", "outputBytes"].every((k) => v[k] === undefined || number(v[k]))
    && ["outputPath", "attemptResultPath", "diagnosticPath", "sessionFile", "model", "evidencePath"].every((k) => v[k] === undefined || text(v[k]))
    && ["output", "error"].every((k) => v[k] === undefined || text(v[k], 128 * 1024))
    && ["partial", "outputTruncated", "autoContinueBlocked", "manualPause", "growthPause", "dynamic", "integration"].every((k) => v[k] === undefined || typeof v[k] === "boolean")
    && ["usage", "attemptUsage", "unclaimedUsage"].every((k) => v[k] === undefined || validUsage(v[k]))
    && (v.cancelSource === undefined || sources.includes(v.cancelSource))
    && (v.stopReason === undefined || ["completed", "cancelled", "timeout", "maxTurns", "error"].includes(v.stopReason));
}
function worktree(v: any, run: any, node: any): boolean {
  return object(v) && text(v.path) && path.basename(v.path) === `pi-mesh-${run.id}-${node.id}-${v.attempt}`
    && integer(v.attempt, 1, node.attempt) && v.repoRoot === run.worktree?.repoRoot
    && text(v.cwd) && (v.cwd === v.path || v.cwd.startsWith(`${v.path}${path.sep}`)) && !path.relative(v.path, v.cwd).startsWith("..")
    && v.branch === `pi-mesh/${run.id}/${node.id}-${v.attempt}`
    && ["baseCommit", "handoffBaseCommit", "finalCommit"].every((k) => k !== "baseCommit" && v[k] === undefined || typeof v[k] === "string" && /^[a-f0-9]{40,64}$/.test(v[k]))
    && ["pending", "complete", "partial"].includes(v.cleanupStatus) && ["ready", "running", "captured", "removed", "partial"].includes(v.phase)
    && ["patchPath", "handoffPath", "cleanupError"].every((k) => v[k] === undefined || text(v[k], 128 * 1024));
}
/** Essential execution fields, finite bounds and graph identity before any mutation.
 * Files/legacy evidence are retained on rejection; no schema dependency needed.
 */
export function validateRunState(value: unknown): asserts value is MeshRun {
  const r: any = value;
  const fail = (field: string): never => { throw new Error(`Invalid checkpoint ${field}; evidence retained, repair this record explicitly`); };
  if (!object(r) || r.schema !== "pi-mesh.run/v2" || !text(r.id, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.id) || !text(r.sessionId) || !text(r.cwd)) fail("identity");
  if (!["running", "paused", "cancelling", "succeeded", "failed", "cancelled"].includes(r.status)
    || !["graph", "sequence", "parallel", "race", "supervisor", "mixture", "reflection", "debate"].includes(r.operator)
    || !integer(r.maxConcurrency, 1, 32) || !integer(r.maxNodes, 1, 128) || typeof r.failFast !== "boolean"
    || !integer(r.revision, 1) || !integer(r.recoveryCount) || !number(r.createdAt) || !number(r.updatedAt) || !optional(r)
    || ["cancelVersion", "epoch", "messagePayloadMaxBytes", "recipientUnreadMaxBytes"].some((k) => r[k] !== undefined && !integer(r[k]))) fail("run fields");
  if (r.worktree !== undefined && (!object(r.worktree) || !text(r.worktree.repoRoot) || !/^[a-f0-9]{40,64}$/.test(r.worktree.baseCommit)
    || r.worktree.setupHook !== undefined && !text(r.worktree.setupHook))) fail("worktree");
  if (!Array.isArray(r.nodes) || !r.nodes.length || r.nodes.length > r.maxNodes) fail("nodes");
  const ids = new Set<string>();
  for (const n of r.nodes) {
    if (!object(n) || !text(n.id, 64) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n.id) || ids.has(n.id)) fail("node identity");
    ids.add(n.id);
    if (!text(n.agent, 128) || !n.agent.trim() || !text(n.task, 65536) || !n.task.trim() || Buffer.byteLength(n.task) > 65536 || !text(n.cwd)
      || !["queued", "running", "paused", "succeeded", "failed", "cancelled", "skipped"].includes(n.status)
      || !integer(n.retries, 0, 5) || !integer(n.attempt) || !optional(n) || n.accountedAttempt !== undefined && !integer(n.accountedAttempt, 0, n.attempt)
      || n.timeoutMs !== undefined && !integer(n.timeoutMs, 100, 3600000)
      || !Array.isArray(n.dependsOn) || n.dependsOn.length > 128 || n.dependsOn.some((id: any) => !text(id, 64))
      || n.allowedSubagents !== undefined && n.allowedSubagents !== "all" && (!Array.isArray(n.allowedSubagents) || n.allowedSubagents.some((v: any) => !text(v, 128)))
      || n.worktree !== undefined && !worktree(n.worktree, r, n)
      || n.worktreeHistory !== undefined && (!Array.isArray(n.worktreeHistory) || n.worktreeHistory.length > 1024 || n.worktreeHistory.some((v: any) => !worktree(v, r, n)))) fail(`node ${n.id} fields`);
    if (n.activity !== undefined && (!object(n.activity) || !validUsage(n.activity.usage) || !integer(n.activity.turns) || !integer(n.activity.toolUses)
      || !text(n.activity.responseText, 128 * 1024) || !text(n.activity.thinkingText, 128 * 1024) || !Array.isArray(n.activity.activeTools) || n.activity.activeTools.some((v: any) => !text(v)))) fail(`node ${n.id} activity`);
  }
  for (const n of r.nodes) if (n.dependsOn.some((id: string) => !ids.has(id))) fail(`node ${n.id} dependency`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const byId = new Map<string, any>(r.nodes.map((n: any) => [n.id, n]));
  const visit = (id: string) => {
    if (visiting.has(id)) fail(`dependency cycle ${id}`);
    if (visited.has(id)) return;
    visiting.add(id); for (const parent of byId.get(id).dependsOn) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}
