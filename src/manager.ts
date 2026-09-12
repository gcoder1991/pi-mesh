import * as crypto from "node:crypto";
import { CONFIG_DIR_NAME, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentDefinition } from "./agents.ts";
import type { ChildResult, Usage } from "./pi-process.ts";
import { boundedDisplay, readBoundedFile, emptyUsage, mergeUsage, trackActivity, truncateUtf8, type AgentActivity } from "./runtime-utils.ts";
import { SubagentRuntime, type SubagentExecution } from "./subagent-runtime.ts";
import { acquireRunLease, type RunLease } from "./run-lease.ts";
import { appendDebugEvent, atomicWriteContent, atomicWriteCheckpoint, attemptDir, attemptResultFile, growthProposals, putGrowth, type ControlMessage, listRunFiles, putAttemptResult, putDiagnosticExplanation, putNodeOutput, readJson, runFile } from "./store.ts";
import { defaultMeshSettings, type MeshSettings } from "./settings.ts";
import { validateRunState, validUsage, CHECKPOINT_MAX_BYTES, INLINE_EVIDENCE_MAX_BYTES, serializedBytes, assertRunAdmission } from "./recovery-state.ts";
import { transitionNode, transitionRun } from "./transitions.ts";
import { WorktreeSetupError, cleanupNodeWorktree, retryWorktreeCommit, createNodeWorktree, finalizeNodeWorktree, prepareWorktreeRun, type WorktreeRunState, type WorktreeState } from "./worktree.ts";

export type MeshCancelSource = "user" | "unknown" | "operator" | "failfast" | "race" | "timeout" | "shutdown";
export type RunStatus = "running" | "paused" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type NodeStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | "skipped";
export type MeshOperator = "graph" | "sequence" | "parallel" | "race" | "supervisor" | "mixture" | "reflection" | "debate";

export interface MeshTask {
  id?: string;
  agent: string;
  task: string;
  dependsOn?: string[];
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  integration?: boolean;
}

export interface MeshNode {
  id: string;
  agent: string;
  task: string;
  dependsOn: string[];
  cwd: string;
  model?: string;
  timeoutMs?: number;
  retries: number;
  attempt: number;
  dynamic?: boolean;
  requestedBy?: string;
  allowedSubagents?: string[] | "all";
  integration?: boolean;
  status: NodeStatus;
  cancelSource?: MeshCancelSource;
  autoContinueBlocked?: boolean;
  output?: string;
  outputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  attemptResultPath?: string;
  diagnosticPath?: string;
  /** Immutable full evidence snapshot; previous links preserve older history. */
  evidencePath?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  usage?: Usage;
  attemptUsage?: Usage;
  accountedAttempt?: number;
  stopReason?: ChildResult["stopReason"];
  partial?: boolean;
  worktree?: WorktreeState;
  worktreeHistory?: WorktreeState[];
  activity?: AgentActivity;
  sessionFile?: string;
}

export interface AttemptResult {
  committedRevision?: number;
  stopReason?: ChildResult["stopReason"];
  partial?: boolean;
  schema: "pi-mesh.attempt-result/v1";
  runId: string;
  nodeId: string;
  attempt: number;
  status: NodeStatus;
  pid?: number;
  startedAt?: number;
  finishedAt: number;
  exitCode: number;
  signal: NodeJS.Signals | null;
  error?: string;
  stderrTail: string;
  model?: string;
  usage: Usage;
  outputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
}

export interface MeshRun {
  schema: "pi-mesh.run/v2";
  id: string;
  sessionId: string;
  status: RunStatus;
  cwd: string;
  maxConcurrency: number;
  maxNodes: number;
  failFast: boolean;
  operator: MeshOperator;
  revision: number;
  recoveryCount: number;
  cancelSource?: MeshCancelSource;
  cancelVersion?: number;
  autoContinueBlocked?: boolean;
  manualPause?: boolean;
  growthPause?: boolean;
  epoch?: number;
  usage?: Usage;
  unclaimedUsage?: Usage;
  messagePayloadMaxBytes?: number;
  recipientUnreadMaxBytes?: number;
  worktree?: WorktreeRunState;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  nodes: MeshNode[];
}

export interface StartRunOptions {
  tasks: MeshTask[];
  cwd: string;
  maxConcurrency?: number;
  maxNodes?: number;
  failFast?: boolean;
  operator?: MeshOperator;
  worktree?: boolean;
  worktreeSetupHook?: string;
  signal?: AbortSignal;
  onCreated?: (run: MeshRun) => void;
  onUpdate?: (run: MeshRun) => void;
}

function existingRealpath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return fs.realpathSync(value); } catch { return undefined; }
}

export class MeshManager {
  private readonly runs = new Map<string, MeshRun>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly closingExecutions = new WeakSet<SubagentExecution>();
  private readonly executionAttempts = new WeakMap<SubagentExecution, number>();
  private readonly subagents = new Map<string, Map<string, SubagentExecution>>();
  private readonly nodeControllers = new Map<string, Map<string, AbortController>>();
  private readonly executions = new Map<string, Map<string, Promise<void>>>();
  private readonly loops = new Map<string, Promise<MeshRun>>();
  private readonly leases = new Map<string, RunLease>();
  private closed = false;
  private readonly retries = new Map<string, Promise<MeshRun>>();
  private readonly resumes = new Map<string, Promise<MeshRun>>();
  private readonly revisions = new Map<string, number>();
  private readonly lost = new Set<string>();
  private readonly hints = new Map<string, { count: number; pending: boolean }>();
  readonly diagnostics: string[] = [];
  private readonly modelRegistry?: ModelRegistry;
  private projectTrusted: boolean;
  private resolveAgent: (name: string, cwd: string) => AgentDefinition | undefined;
  private settings: MeshSettings;
  private subagentRuntime: SubagentRuntime;
  private readonly limiter?: import("./fleet-limiter.ts").FleetLimiter;
  private readonly sessionId: string;
  constructor(resolveAgent: (name: string, cwd: string) => AgentDefinition | undefined, settings: MeshSettings = defaultMeshSettings, limiter?: import("./fleet-limiter.ts").FleetLimiter, modelRegistry?: ModelRegistry, sessionId = "default", projectTrusted = false) {
    this.modelRegistry = modelRegistry;
    this.projectTrusted = projectTrusted;
    this.resolveAgent = resolveAgent;
    this.settings = settings;
    this.limiter = limiter;
    this.sessionId = sessionId;
    this.subagentRuntime = new SubagentRuntime(settings, modelRegistry ? { modelRegistry, projectTrusted } : undefined);
  }

  updateAuthorization(settings: MeshSettings, projectTrusted: boolean, resolveAgent = this.resolveAgent): void {
    this.resolveAgent = resolveAgent;
    if (JSON.stringify(settings) === JSON.stringify(this.settings) && projectTrusted === this.projectTrusted) return;
    this.subagentRuntime = new SubagentRuntime(settings, this.modelRegistry ? { modelRegistry: this.modelRegistry, projectTrusted } : undefined);
    this.settings = settings; this.projectTrusted = projectTrusted;
  }

  notifyMessageStored(message: ControlMessage): void {
    const run = this.runs.get(message.runId), node = run?.nodes.find((item) => item.id === message.to);
    const execution = this.subagents.get(message.runId)?.get(message.to);
    if (!this.settings.mailboxNotifications || this.closed || run?.status !== "running" || node?.status !== "running" || !execution || this.closingExecutions.has(execution) || this.executionAttempts.get(execution) !== node.attempt || this.nodeControllers.get(run.id)?.get(node.id)?.signal.aborted) return;
    const key = `${run.id}/${node.id}/${node.attempt}`;
    const hint = this.hints.get(key) ?? { count: 0, pending: false };
    if (hint.pending || hint.count >= 8) return;
    hint.pending = true; this.hints.set(key, hint);
    queueMicrotask(() => {
      hint.pending = false;
      if (this.closed || run.status !== "running" || node.status !== "running" || key !== `${run.id}/${node.id}/${node.attempt}` || this.subagents.get(run.id)?.get(node.id) !== execution || this.closingExecutions.has(execution) || this.executionAttempts.get(execution) !== node.attempt || this.nodeControllers.get(run.id)?.get(node.id)?.signal.aborted) return;
      try { this.assertOwner(run); execution.steer("[Host mailbox hint] New stored mail. Use mesh_control inbox to inspect senderAttempt, createdAt and replyTo; ack means receipt, not task completion."); hint.count++; }
      catch (error) { this.diagnostics.push(String(error)); }
    });
  }

  claimUsage(runId: string): Usage | undefined {
    const run = this.runs.get(runId);
    if (!run?.unclaimedUsage || this.loops.has(runId)) return undefined;
    this.ensureLease(run);
    const usage = run.unclaimedUsage;
    run.unclaimedUsage = undefined;
    try { this.touch(run); } catch (error) { run.unclaimedUsage = usage; throw error; }
    finally { this.releaseLease(runId); }
    return usage;
  }

  decideGrowth(runId: string, proposalId: string, decision: "approve" | "deny", tasks?: MeshTask[]): boolean {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown mesh run: ${runId}`);
    this.ensureLease(run);
    try {
      const proposal = growthProposals<MeshTask[]>(run.cwd, run.id).find((item) => item.id === proposalId);
      if (!proposal || proposal.status !== "proposed") throw new Error("Growth proposal is not pending");
      if (decision === "approve") {
        const requester = run.nodes.find((node) => node.id === proposal.requester);
        if (!requester || requester.attempt !== proposal.requesterAttempt || proposal.baseRevision > run.revision) throw new Error("Growth proposal requester/revision is stale");
        proposal.committedNodeIds = this.grow(runId, proposal.requester, tasks ?? proposal.tasks).map((node) => node.id);
        proposal.status = "committed";
      } else proposal.status = "denied";
      this.assertOwner(run);
      proposal.decidedAt = Date.now(); putGrowth(run.cwd, proposal);
      run.growthPause = growthProposals(run.cwd, run.id).some((item) => item.status === "proposed");
      this.touch(run);
      return run.status === "paused" && !run.growthPause && !run.manualPause;
    } finally { if (!this.loops.has(runId)) this.releaseLease(runId); }
  }

  recover(cwd: string): MeshRun[] {
    if (this.closed) throw new Error("Mesh manager is shut down");
    const root = fs.realpathSync(path.resolve(cwd));
    for (const file of listRunFiles(cwd)) {
      let run: MeshRun;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CHECKPOINT_MAX_BYTES) throw new Error("Checkpoint must be a regular file <=16MiB");
        const value: unknown = readJson(file);
        validateRunState(value); run = value;
        if (run.sessionId !== this.sessionId) continue;
        if (path.basename(file) !== `${run.id}.json` || existingRealpath(run.cwd) !== root || run.nodes.some((node) => {
          const nodeCwd = existingRealpath(node.cwd); if (!nodeCwd) return true;
          const relative = path.relative(root, nodeCwd);
          return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        })) throw new Error("Checkpoint identity/cwd escapes run root");
        if (run.worktree) {
          const repo = existingRealpath(run.worktree.repoRoot);
          const inside = (candidate: string) => { const rel = path.relative(repo!, candidate); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
          if (!repo || !inside(root) || run.worktree.setupHook && (!existingRealpath(run.worktree.setupHook) || !inside(existingRealpath(run.worktree.setupHook)!))) throw new Error("Worktree repository/setupHook escapes run ownership");
        }
        this.assertAcyclic(run.nodes); this.assertDepth(run.nodes);
      } catch (error) {
        this.diagnostics.push(`Recovery skipped ${file}: ${String(error)}. Original file and any prior safe in-memory reference retained.`);
        continue;
      }
      if (this.loops.has(run.id) || this.executions.get(run.id)?.size || this.retries.has(run.id) || this.resumes.has(run.id)) continue;
      this.releaseLease(run.id);
      this.lost.delete(run.id);
      this.revisions.set(run.id, run.revision);
      const interrupted = run.nodes.filter((node) => node.status === "running");
      if (interrupted.length || run.status === "cancelling") {
        this.ensureLease(run);
        try {
        run.recoveryCount++;
        for (const node of interrupted) {
          let result: AttemptResult | undefined;
          try {
            result = this.recoveredAttemptResult(run, node);
          } catch (error) {
            transitionNode(node, "failed");
            node.finishedAt = Date.now();
            node.error = `Recovery error: ${error instanceof Error ? error.message : String(error)}`;
            this.debug(run, "attempt_result_recovery_failed", { nodeId: node.id, attempt: node.attempt, error: node.error });
            continue;
          }
          if (node.worktree && !this.projectTrusted) {
            transitionNode(node, "failed"); node.error = `Host trust is required for worktree recovery. Worktree preserved at ${node.worktree.path}; trust explicitly and preserve it before a new Agent.`;
            continue;
          }
          if (result) {
            if (node.worktree?.cleanupStatus === "pending" && node.worktree.phase !== "captured") {
              node.worktree = finalizeNodeWorktree(run.cwd, run.id, node.id, node.worktree, result.status, node.output ?? "Recovered from attempt result", false);
              node.worktreeHistory = [...(node.worktreeHistory ?? []), node.worktree];
              if (node.worktree.cleanupStatus === "partial") {
                node.error = `Worktree handoff failed; preserved at ${node.worktree.path}: ${node.worktree.cleanupError}`;
                this.debug(run, "recovered_worktree_handoff_failed", { nodeId: node.id, attempt: node.attempt, path: node.worktree.path, error: node.worktree.cleanupError });
              }
            }
            if (node.worktree?.phase === "partial") { result.status = "failed"; result.error = node.error; }
            this.applyRecoveredAttemptResult(run, node, result);
            this.debug(run, "attempt_result_recovered", { nodeId: node.id, attempt: node.attempt, status: node.status, attemptResultPath: node.attemptResultPath });
            continue;
          }
          if (node.worktree?.cleanupStatus === "pending") {
            node.worktree = finalizeNodeWorktree(run.cwd, run.id, node.id, node.worktree, "interrupted", "Recovered after host restart", false);
            node.worktreeHistory = [...(node.worktreeHistory ?? []), node.worktree];
          }
          if (node.worktree?.cleanupStatus === "partial") {
            transitionNode(node, "failed");
            node.error = `Recovery could not preserve worktree at ${node.worktree.path}: ${node.worktree.cleanupError}`;
          } else {
            transitionNode(node, run.status === "paused" ? "paused" : "queued");
            node.startedAt = undefined;
            node.error = "Recovered after host restart";
          }
        }
        if (run.status === "cancelling") {
          for (const node of run.nodes) if (["queued", "paused"].includes(node.status)) transitionNode(node, "cancelled");
          transitionRun(run, "cancelled");
        }
        this.touch(run);
        } finally { this.releaseLease(run.id); }
      }
      this.runs.set(run.id, run);
    }
    return this.list();
  }

  list(): MeshRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(runId: string): MeshRun | undefined {
    return this.runs.get(runId);
  }

  conversation(runId: string, nodeId: string): string {
    return this.subagents.get(runId)?.get(nodeId)?.conversation() ?? "";
  }

  /** Synchronous active-only bridge fence; never takes a new lease or queues a hint. */
  bridgeHint(runId: string, nodeId: string, attempt: number, message: string): boolean {
    const run = this.runs.get(runId), node = run?.nodes.find(n => n.id === nodeId);
    const execution = this.subagents.get(runId)?.get(nodeId);
    if (this.closed || !this.projectTrusted || run?.status !== "running" || run.autoContinueBlocked || node?.status !== "running" || node.autoContinueBlocked || node.attempt !== attempt || !execution || this.closingExecutions.has(execution) || this.executionAttempts.get(execution) !== attempt || this.controllers.get(runId)?.signal.aborted || this.nodeControllers.get(runId)?.get(nodeId)?.signal.aborted) return false;
    this.assertOwner(run);
    return execution.steerActive?.(message) ?? false;
  }

  steer(runId: string, nodeId: string, message: string): boolean {
    const node = this.runs.get(runId)?.nodes.find((item) => item.id === nodeId);
    const execution = this.subagents.get(runId)?.get(nodeId);
    if (this.closed || this.runs.get(runId)?.status !== "running" || !node || node.status !== "running" || !execution) return false;
    this.ensureLease(this.runs.get(runId)!);
    execution.steer(message);
    this.debug(this.runs.get(runId)!, "node_steered", { nodeId, attempt: node.attempt });
    return true;
  }

  cancel(runId: string, nodeId?: string, source: MeshCancelSource = "unknown"): boolean {
    const run = this.runs.get(runId);
    // A terminal-visible old epoch may still have a pending retry waiting for
    // close. Revoke that operation by version/lock, without reopening or changing
    // the old terminal status (including any successful nodes).
    if (this.closed || !run || (!["running", "paused", "cancelling"].includes(run.status) && !this.retries.has(runId))) return false;
    const node = nodeId ? run.nodes.find((item) => item.id === nodeId) : undefined;
    if (nodeId && (!node || (!["queued", "running", "paused"].includes(node.status) && !this.retries.has(runId)))) return false;
    this.ensureLease(run);
    run.cancelVersion = (run.cancelVersion ?? 0) + 1;
    const target = node ?? run;
    if (!target.autoContinueBlocked || source === "user" || source === "unknown") target.cancelSource = source;
    if (source === "user" || source === "unknown") target.autoContinueBlocked = true;
    if (!nodeId) {
      if (["running", "paused"].includes(run.status)) transitionRun(run, "cancelling");
      this.controllers.get(runId)?.abort();
      for (const node of run.nodes) if (["queued", "paused"].includes(node.status)) transitionNode(node, "cancelled");
      if (!this.loops.has(runId) && !this.executions.get(runId)?.size) {
        for (const node of run.nodes) if (node.status === "running") transitionNode(node, "cancelled");
        if (run.status === "cancelling") transitionRun(run, "cancelled"); run.finishedAt = Date.now();
      }
      this.touch(run);
      if (!this.loops.has(runId)) this.releaseLease(runId);
      return true;
    }
    if (["queued", "running", "paused"].includes(node!.status)) transitionNode(node!, "cancelled");
    this.nodeControllers.get(runId)?.get(nodeId)?.abort();
    this.touch(run);
    return true;
  }

  pause(runId: string): boolean {
    const run = this.runs.get(runId);
    if (this.closed || !run || !["running", "paused"].includes(run.status)) return false;
    this.ensureLease(run);
    run.manualPause = true;
    transitionRun(run, "paused");
    for (const node of run.nodes) if (node.status === "queued") transitionNode(node, "paused");
    for (const [id, controller] of this.nodeControllers.get(run.id) ?? []) if (!this.subagents.get(run.id)?.has(id)) controller.abort("pause");
    this.touch(run);
    return true;
  }

  resume(runId: string): Promise<MeshRun> {
    if (this.closed) throw new Error("Mesh manager is shut down");
    const existing = this.resumes.get(runId); if (existing) return existing;
    const run = this.runs.get(runId);
    if (!run || run.status !== "paused") throw new Error(`Mesh is not paused: ${runId}`);
    const flight = (async () => {
      await this.loops.get(runId);
      if (this.closed || run.status !== "paused" || run.autoContinueBlocked) throw new Error("Mesh cannot resume after shutdown/cancel; recheck status");
      if (run.worktree && !this.projectTrusted) throw new Error("Worktree resume requires current Host project trust; trust explicitly or start a new non-worktree Agent.");
      this.ensureLease(run);
      if (growthProposals(run.cwd, run.id).some((item) => item.status === "proposed")) { this.releaseLease(run.id); throw new Error("Decide pending growth before resume"); }
      run.manualPause = false; run.growthPause = false;
      for (const node of run.nodes) if (node.status === "paused") transitionNode(node, "queued");
      transitionRun(run, "running");
      this.touch(run);
      return this.runLoop(run);
    })();
    this.resumes.set(runId, flight);
    void flight.then(() => this.resumes.delete(runId), () => this.resumes.delete(runId));
    return flight;
  }

  retryFailed(runId: string, signal?: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<MeshRun> {
    return this.retry(runId, false, signal, onUpdate);
  }

  /** Host user-command entry point only; never exposed as a model/tool argument. */
  retryFailedFromUser(runId: string): Promise<MeshRun> {
    return this.retry(runId, true);
  }

  private retry(runId: string, user: boolean, signal?: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<MeshRun> {
    if (this.closed) throw new Error("Mesh manager is shut down");
    const existing = this.retries.get(runId); if (existing) return this.retryCaller(runId, existing, signal);
    const run = this.runs.get(runId);
    if (!run || !["failed", "cancelled", "cancelling"].includes(run.status)) throw new Error(`Mesh is not failed or cancelled: ${runId}`);
    const version = run.cancelVersion ?? 0;
    const flight = (async () => {
      await this.loops.get(runId); // includes child completion, close, loop finally and lease release
      if (this.closed || signal?.aborted || !["failed", "cancelled"].includes(run.status)) throw new Error("Mesh cannot retry after shutdown/cancel; recheck status");
      if ((run.cancelVersion ?? 0) !== version) throw new Error("New cancellation while draining; user authorization required again");
      if (run.worktree && !this.projectTrusted) throw new Error("Worktree retry requires current Host project trust; trust explicitly or start a new non-worktree Agent.");
      this.ensureLease(run);
      try {
        const legacyStop = run.status === "cancelled" && !run.cancelSource && !run.nodes.some((node) => node.cancelSource);
        if (!user && (run.autoContinueBlocked || legacyStop)) throw new Error(`User authorization required after ${run.cancelSource ?? "unknown"} cancellation: /mesh retry ${run.id}`);
        const blocked = new Set(user ? [] : run.nodes.filter((node) => node.autoContinueBlocked || (node.status === "cancelled" && !node.cancelSource && !run.cancelSource)).map((node) => node.id));
        // Do not reopen dependents of a stopped node, but unrelated failures remain retryable.
        for (let n = 0; n < run.nodes.length; n++) for (const node of run.nodes) if (node.dependsOn.some((id) => blocked.has(id))) blocked.add(node.id);
        const retryable = run.nodes.filter((node) => node.status !== "succeeded" && !blocked.has(node.id));
        if (!retryable.length) throw new Error(`No authorized unsuccessful nodes; user authorization: /mesh retry ${run.id}`);
        if (user) { run.autoContinueBlocked = false; for (const node of retryable) node.autoContinueBlocked = false; }
        // Only this authorized, drained new epoch may reopen terminal state.
        for (const node of retryable) { node.status = "queued"; node.startedAt = undefined; node.finishedAt = undefined; node.activity = undefined; }
        run.status = "running"; run.finishedAt = undefined;
        this.touch(run);
        this.debug(run, "failed_nodes_retried", { nodeIds: retryable.map((node) => node.id), authorization: user ? "user-command" : "ordinary" });
        return this.runLoop(run, undefined, onUpdate);
      } finally { if (!this.loops.has(runId)) this.releaseLease(runId); }
    })();
    this.retries.set(runId, flight);
    const settled = () => { this.retries.delete(runId); };
    void flight.then(settled, settled);
    return this.retryCaller(runId, flight, signal);
  }

  private retryCaller(runId: string, flight: Promise<MeshRun>, signal?: AbortSignal): Promise<MeshRun> {
    const abort = () => { try { this.cancel(runId, undefined, "unknown"); } catch (error) { this.diagnostics.push(`Retry cancellation: ${String(error)}`); } };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const settled = () => { signal?.removeEventListener("abort", abort); };
    void flight.then(settled, settled);
    return flight;
  }

  resumeRecovered(runId: string): Promise<MeshRun> {
    if (this.closed) throw new Error("Mesh manager is shut down");
    const run = this.runs.get(runId);
    if (!run || run.status !== "running" || run.autoContinueBlocked) throw new Error(`Mesh is not recoverable: ${runId}`);
    this.ensureLease(run);
    return this.runLoop(run);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) {
      if (!this.loops.has(run.id) && !this.executions.get(run.id)?.size && !this.leases.has(run.id)) continue;
      try {
        this.assertOwner(run);
        if (run.status === "running") transitionRun(run, "paused");
        if (!run.autoContinueBlocked) run.cancelSource = "shutdown";
        for (const node of run.nodes) if (node.status === "queued") transitionNode(node, "paused");
        this.touch(run);
      } catch (error) { this.diagnostics.push(String(error)); }
      this.controllers.get(run.id)?.abort();
      for (const controller of this.nodeControllers.get(run.id)?.values() ?? []) controller.abort();
    }
    await Promise.allSettled([...this.loops.values(), ...this.resumes.values(), ...this.retries.values()]);
    for (const id of this.leases.keys()) this.releaseLease(id);
    this.hints.clear();
  }

  grow(runId: string, requester: string, tasks: MeshTask[]): MeshNode[] {
    const run = this.runs.get(runId);
    if (this.closed || !run || !["running", "paused"].includes(run.status)) throw new Error(`Mesh is not active: ${runId}`);
    this.ensureLease(run);
    const requesterNode = run.nodes.find((node) => node.id === requester);
    if (!requesterNode) throw new Error(`Unknown requester node: ${requester}`);
    if (!["running", "paused", "succeeded"].includes(requesterNode.status)) throw new Error(`Requester ${requester} is not available`);
    const currentRequester = this.resolveAgent(requesterNode.agent, requesterNode.cwd);
    if (!currentRequester || (currentRequester.source === "project" && !this.projectTrusted)) throw new Error("Growth requester is no longer Host-authorized");
    if (currentRequester.allowedSubagents !== "all") {
      const allowed = new Set((currentRequester.allowedSubagents ?? []).map((name) => name.toLowerCase()));
      const denied = tasks.map((task) => task.agent).filter((name) => !allowed.has(name.toLowerCase()));
      if (denied.length) throw new Error(`Requester ${requester} cannot grow agents: ${[...new Set(denied)].join(", ")}`);
    }
    if (requesterNode.allowedSubagents !== "all") {
      const allowed = new Set((requesterNode.allowedSubagents ?? []).map((name) => name.toLowerCase()));
      const denied = tasks.map((task) => task.agent).filter((name) => !allowed.has(name.toLowerCase()));
      if (denied.length) throw new Error(`Requester ${requester} cannot grow agents: ${[...new Set(denied)].join(", ")}`);
    }
    const added = this.prepareNodes(run, tasks, true, requester);
    if (run.nodes.length + added.length > run.maxNodes) throw new Error(`Growth exceeds maxNodes ${run.maxNodes}`);
    this.assertAcyclic([...run.nodes, ...added]);
    this.assertDepth([...run.nodes, ...added]);
    const candidate = { ...run, nodes: [...run.nodes, ...added] };
    validateRunState(candidate); assertRunAdmission(candidate);
    run.nodes.push(...added);
    this.touch(run);
    return added;
  }

  create(options: StartRunOptions): MeshRun {
    if ((options.worktree || options.worktreeSetupHook) && !this.projectTrusted) throw new Error("Worktree/setupHook requires current Host project trust; trust the project explicitly or start a new non-worktree Agent.");
    if (this.closed) throw new Error("Mesh manager is shut down");
    const maxConcurrency = options.maxConcurrency ?? this.settings.maxConcurrentAgents;
    const maxNodes = options.maxNodes ?? this.settings.maxNodes;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > this.settings.maxConcurrentAgents) throw new Error(`maxConcurrency must be 1-${this.settings.maxConcurrentAgents}`);
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > this.settings.maxNodes) throw new Error(`maxNodes must be 1-${this.settings.maxNodes}`);
    if (options.tasks.length < 1 || options.tasks.length > Math.min(32, maxNodes)) throw new Error("tasks must contain 1-32 items within maxNodes");

    const now = Date.now();
    const run: MeshRun = {
      schema: "pi-mesh.run/v2",
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      status: "running",
      cwd: fs.realpathSync(path.resolve(options.cwd)),
      maxConcurrency,
      maxNodes,
      failFast: options.failFast ?? false,
      operator: options.operator ?? "graph",
      revision: 1,
      recoveryCount: 0,
      messagePayloadMaxBytes: this.settings.messagePayloadMaxBytes,
      recipientUnreadMaxBytes: this.settings.recipientUnreadMaxBytes,
      createdAt: now,
      updatedAt: now,
      nodes: [],
    };
    const operator = options.operator ?? "graph";
    if (["supervisor", "mixture"].includes(operator) && options.tasks.length < 2) throw new Error(`${operator} requires workers plus a final synthesizer`);
    const tasks = (["sequence", "reflection", "debate"].includes(operator))
      ? options.tasks.map((task, index) => ({ ...task, dependsOn: index === 0 ? task.dependsOn : [...(task.dependsOn ?? []), options.tasks[index - 1].id?.trim() || `task-${index}`] }))
      : ["supervisor", "mixture"].includes(operator)
        ? options.tasks.map((task, index) => index === options.tasks.length - 1
          ? { ...task, dependsOn: [...new Set([...(task.dependsOn ?? []), ...options.tasks.slice(0, -1).map((worker, workerIndex) => worker.id?.trim() || `task-${workerIndex + 1}`)])] }
          : task)
        : options.tasks;
    run.nodes = this.prepareNodes(run, tasks, false);
    this.assertAcyclic(run.nodes);
    this.assertDepth(run.nodes);
    validateRunState(run); assertRunAdmission(run);
    if (options.worktree) run.worktree = prepareWorktreeRun(run.cwd, run.nodes.map((node) => node.cwd), options.worktreeSetupHook);
    this.ensureLease(run);
    this.runs.set(run.id, run);
    try { this.persist(run); } catch (error) {
      // atomicWrite can fail after rename (e.g. directory fsync). An unconfirmed
      // admission must not remain a runnable checkpoint even then.
      try {
        if (this.leases.get(run.id)?.isOwner() && fs.existsSync(runFile(run.cwd, run.id)) && fs.readFileSync(runFile(run.cwd, run.id), "utf8") === `${JSON.stringify(run, null, 2)}\n`) fs.rmSync(runFile(run.cwd, run.id));
      } catch (cleanup) { this.diagnostics.push(`Unconfirmed admission cleanup failed; no child started: ${String(cleanup)}`); }
      this.runs.delete(run.id); this.revisions.delete(run.id); this.releaseLease(run.id); throw error;
    }
    this.debug(run, "run_started", { maxConcurrency: run.maxConcurrency, maxNodes: run.maxNodes, operator: run.operator, nodeCount: run.nodes.length, worktree: Boolean(run.worktree) });
    options.onCreated?.(run);
    return run;
  }

  startCreated(runId: string, signal?: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<MeshRun> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") throw new Error(`Mesh is not runnable: ${runId}`);
    return this.runLoop(run, signal, onUpdate);
  }

  async start(options: StartRunOptions): Promise<MeshRun> {
    const run = this.create(options);
    return this.startCreated(run.id, options.signal, options.onUpdate);
  }

  private prepareNodes(run: MeshRun, tasks: MeshTask[], dynamic: boolean, requester?: string): MeshNode[] {
    const ids = new Set(run.nodes.map((node) => node.id));
    const nodes = tasks.map((task, index): MeshNode => {
      const id = task.id?.trim() || `${dynamic ? "growth" : "task"}-${run.nodes.length + index + 1}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`Invalid task id: ${id}`);
      if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
      ids.add(id);
      if (!task.task.trim() || Buffer.byteLength(task.task, "utf8") > 64 * 1024) throw new Error(`Invalid task text for ${id}`);
      const rootCwd = fs.realpathSync(run.cwd);
      const nodeCwd = fs.realpathSync(path.resolve(task.cwd ?? run.cwd));
      const relative = path.relative(rootCwd, nodeCwd);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Task cwd must remain inside the run root: ${id}`);
      const agent = this.resolveAgent(task.agent, nodeCwd);
      if (!agent) throw new Error(`Unknown agent: ${task.agent}`);
      if ((task.retries ?? 0) < 0 || (task.retries ?? 0) > 5) throw new Error(`retries must be 0-5 for ${id}`);
      if (task.timeoutMs !== undefined && (task.timeoutMs < 100 || task.timeoutMs > 3_600_000)) throw new Error(`timeoutMs must be 100-3600000 for ${id}`);
      return {
        id, agent: task.agent, task: task.task, dependsOn: task.dependsOn ?? [], cwd: nodeCwd,
        model: task.model, timeoutMs: task.timeoutMs ?? this.settings.defaultNodeTimeoutMs, retries: task.retries ?? 0, attempt: 0,
        dynamic, requestedBy: requester, allowedSubagents: agent.allowedSubagents, integration: task.integration, status: run.status === "paused" ? "paused" : "queued",
      };
    });
    for (const node of nodes) for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new Error(`Task ${node.id} depends on unknown task ${dependency}`);
    return nodes;
  }

  private runLoop(run: MeshRun, externalSignal?: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<MeshRun> {
    if (this.closed) throw new Error("Mesh manager is shut down");
    if (run.autoContinueBlocked) throw new Error(`User authorization required: /mesh retry ${run.id}`);
    const existing = this.loops.get(run.id);
    if (existing) return existing;
    if (run.worktree && !this.projectTrusted) throw new Error("Worktree execution requires current Host project trust; trust explicitly or start a new non-worktree Agent.");
    assertRunAdmission(run);
    this.ensureLease(run);
    run.epoch = (run.epoch ?? 0) + 1;
    try { this.touch(run); } catch (error) { this.releaseLease(run.id); throw error; }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const relayAbort = () => { this.cancel(run.id, undefined, "unknown"); controller.abort(); };
    if (externalSignal?.aborted) relayAbort();
    else externalSignal?.addEventListener("abort", relayAbort, { once: true });
    this.subagents.set(run.id, new Map());
    this.nodeControllers.set(run.id, new Map());
    this.executions.set(run.id, new Map());

    const reportUpdate = () => {
      try { this.assertOwner(run); onUpdate?.(run); }
      catch (error) { this.diagnostics.push(`Update callback: ${String(error)}`); }
    };
    let lastUpdateAt = 0;
    let pendingUpdate: NodeJS.Timeout | undefined;
    const emitUpdate = (force = false) => {
      if (!onUpdate) return;
      const now = Date.now();
      const remaining = 500 - (now - lastUpdateAt);
      if (!force && remaining > 0) {
        if (!pendingUpdate) {
          pendingUpdate = setTimeout(() => { pendingUpdate = undefined; lastUpdateAt = Date.now(); reportUpdate(); }, remaining);
          pendingUpdate.unref?.();
        }
        return;
      }
      if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = undefined; }
      lastUpdateAt = now;
      reportUpdate();
    };

    const loop = (async () => {
      try {
        while (run.status === "running" || run.status === "cancelling") {
          this.assertOwner(run);
          if (run.status === "running" && growthProposals(run.cwd, run.id).some((proposal) => proposal.status === "proposed")) {
            run.growthPause = true;
            transitionRun(run, "paused");
            for (const node of run.nodes) if (node.status === "queued") transitionNode(node, "paused");
            for (const [id, waiting] of this.nodeControllers.get(run.id) ?? []) if (!this.subagents.get(run.id)?.has(id)) waiting.abort("pause");
            this.touch(run);
            emitUpdate(true);
            continue;
          }
          const active = this.executions.get(run.id)?.size ?? 0;
          const ready = run.nodes.filter((node) => !controller.signal.aborted && run.status === "running" && !node.autoContinueBlocked && node.status === "queued" && node.dependsOn.every((id) => run.nodes.find((candidate) => candidate.id === id)?.status === "succeeded"));
          const blocked = run.nodes.filter((node) => node.status === "queued" && node.dependsOn.some((id) => ["failed", "cancelled", "skipped"].includes(run.nodes.find((candidate) => candidate.id === id)?.status ?? "")));
          for (const node of blocked) transitionNode(node, "skipped");
          for (const node of ready.slice(0, Math.max(0, run.maxConcurrency - active))) {
            const notify = () => emitUpdate();
            const execution = this.executeNode(run, node, controller.signal, notify).catch((error) => {
              this.diagnostics.push(String(error));
              if (!this.lost.has(run.id)) {
                try { if (!["succeeded", "failed", "cancelled"].includes(node.status)) this.failNode(run, node, String(error), notify); }
                catch (failure) { controller.abort(); this.diagnostics.push(String(failure)); }
              }
            });
            this.executions.get(run.id)?.set(node.id, execution);
            void execution.then(() => this.executions.get(run.id)?.delete(node.id), () => this.executions.get(run.id)?.delete(node.id));
          }
          if (blocked.length || ready.length) this.touch(run);
          emitUpdate();

          if (controller.signal.aborted) {
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) transitionNode(node, "cancelled");
            transitionRun(run, "cancelled");
            break;
          }
          if (run.operator === "race" && run.nodes.some((node) => node.status === "succeeded")) {
            if (!run.autoContinueBlocked) run.cancelSource = "race";
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) if (!node.autoContinueBlocked) node.cancelSource = "race";
            controller.abort();
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) transitionNode(node, "cancelled");
            transitionRun(run, "succeeded");
            break;
          }
          if (run.failFast && run.nodes.some((node) => node.status === "failed")) {
            if (!run.autoContinueBlocked) run.cancelSource = "failfast";
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) if (!node.autoContinueBlocked) node.cancelSource = "failfast";
            controller.abort();
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) transitionNode(node, "cancelled");
            transitionRun(run, "failed");
            break;
          }
          if (run.nodes.every((node) => ["succeeded", "failed", "cancelled", "skipped"].includes(node.status))) {
            transitionRun(run, run.nodes.every((node) => node.status === "succeeded") ? "succeeded" : run.nodes.some((node) => node.status === "cancelled") ? "cancelled" : "failed");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await Promise.allSettled([...this.executions.get(run.id)?.values() ?? []]);
        if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = undefined; }
        if (!this.lost.has(run.id) && run.status === "cancelling") {
          this.assertOwner(run);
          for (const node of run.nodes) if (["queued", "paused", "running"].includes(node.status)) transitionNode(node, "cancelled");
          transitionRun(run, "cancelled");
        }
        if (!this.lost.has(run.id) && run.status !== "paused") run.finishedAt = Date.now();
        this.controllers.delete(run.id);
        this.subagents.delete(run.id);
        this.nodeControllers.delete(run.id);
        this.executions.delete(run.id);
        this.loops.delete(run.id);
        externalSignal?.removeEventListener("abort", relayAbort);
        try { if (!this.lost.has(run.id)) { this.touch(run); emitUpdate(true); } }
        finally { this.releaseLease(run.id); }
      }
      return run;
    })();
    this.loops.set(run.id, loop);
    return loop;
  }

  private async executeNode(run: MeshRun, node: MeshNode, signal: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<void> {
    if (node.status !== "queued") return;
    this.assertOwner(run);
    const controller = new AbortController();
    this.nodeControllers.get(run.id)?.set(node.id, controller);
    const relay = () => controller.abort(signal.reason);
    if (signal.aborted) relay(); else signal.addEventListener("abort", relay, { once: true });
    let child: SubagentExecution | undefined, release: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined, warning: NodeJS.Timeout | undefined;
    let timedOut = false, preserveWorktree = false;
    node.attempt++;
    const attempt = node.attempt;
    const current = () => { this.assertOwner(run); if (node.attempt !== attempt) throw new Error("Stale Mesh attempt; recover explicitly"); };
    const abortChild = () => child?.abort(timedOut ? "timeout" : "cancelled");
    controller.signal.addEventListener("abort", abortChild);
    transitionNode(node, "running");
    node.startedAt = Date.now(); node.finishedAt = undefined;
    node.activity = { turns: 0, toolUses: 0, responseText: "", thinkingText: "", activeTools: [], usage: emptyUsage() };
    let result: ChildResult | undefined;
    try {
      this.touch(run);
      if (node.timeoutMs) timer = setTimeout(() => { timedOut = true; controller.abort("timeout"); }, node.timeoutMs);
      release = await this.limiter?.acquire(controller.signal);
      current();
      if (controller.signal.aborted || this.closed || (node.status as NodeStatus) === "cancelled") throw new Error("Child cancelled before launch");
      // Authorization is resolved AFTER taking quota, never from a queued snapshot.
      const agent = this.resolveAgent(node.agent, node.cwd);
      if (!agent || (agent.source === "project" && !this.projectTrusted)) throw new Error(`Agent no longer authorized: ${node.agent}`);
      node.allowedSubagents = agent.allowedSubagents;
      if (run.worktree) {
        if (!this.projectTrusted) throw new Error("Worktree requires current Host project trust; trust explicitly or start a new non-worktree Agent.");
        const parents = [...new Set(node.dependsOn.map((id) => run.nodes.find((item) => item.id === id)?.worktree?.finalCommit).filter((commit): commit is string => Boolean(commit && commit !== run.worktree!.baseCommit)))];
        if (parents.length > 1 && !node.integration) throw new Error(`Task ${node.id} has multiple writer dependencies; mark it integration: true to merge their patches explicitly`);
        const previous = node.worktree;
        if (previous && previous.phase === "partial") throw new Error(`Previous worktree could not be preserved: ${previous.path}; repair before retrying`);
        const base = previous ? retryWorktreeCommit(run.worktree, run.id, node.id, previous) : parents.length === 1 ? parents[0] : run.worktree.baseCommit;
        node.worktree = createNodeWorktree(run.worktree, run.id, node.id, attempt, node.cwd, base, previous?.handoffBaseCommit ?? previous?.baseCommit ?? base);
        node.worktree.phase = "running";
      }
      if (node.sessionFile && !this.validSessionFile(run, node.sessionFile, node.id)) node.sessionFile = undefined;
      assertRunAdmission(run);
      this.touch(run);
      child = this.subagentRuntime.start(agent, {
        id: `${run.id}-${node.id}-${attempt}`, cwd: node.worktree?.cwd ?? node.cwd,
        prompt: this.nodePrompt(run, node), model: node.model, thinking: agent.thinking, maxTurns: agent.maxTurns,
        persistent: true, sessionDir: path.join(run.cwd, CONFIG_DIR_NAME, "mesh", "sessions", "mesh", run.id, node.id), sessionFile: node.sessionFile,
        mesh: { root: run.cwd, runId: run.id, nodeId: node.id, attempt, onMessageStored: (message) => this.notifyMessageStored(message) },
        onReady: (ready) => { current(); if (ready.sessionFile) {
          const root = path.join(run.cwd, CONFIG_DIR_NAME, "mesh", "sessions", "mesh", run.id, node.id);
          const relative = path.relative(root, ready.sessionFile);
          if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(ready.sessionFile) !== ".jsonl") throw new Error("Unsafe Mesh ready session file");
          node.sessionFile = ready.sessionFile; this.touch(run); } },
        onEvent: (event) => { try { current(); trackActivity(node, event); } catch { controller.abort(); } },
      });
      this.subagents.get(run.id)?.set(node.id, child);
      this.executionAttempts.set(child, attempt);
      if (controller.signal.aborted) abortChild();
      if (node.timeoutMs) warning = setTimeout(() => { if (!controller.signal.aborted) child?.steer("Time limit is approaching. Preserve work and return bounded validation now."); }, Math.max(1, Math.floor(node.timeoutMs * 0.8)));
      result = await child.completion;
    } catch (error) {
      if (error instanceof WorktreeSetupError) { node.worktree = error.state; preserveWorktree = true; }
      result = { exitCode: 1, signal: null, output: node.activity?.responseText ?? "", stderr: "", usage: node.activity?.usage ?? emptyUsage(), error: String(error), stopReason: "error", partial: true };
    } finally {
      if (timer) clearTimeout(timer); if (warning) clearTimeout(warning);
      if (child) this.closingExecutions.add(child);
      try { await child?.close(); } catch (error) {
        result = { ...(result ?? { exitCode: 1, signal: null, output: "", stderr: "", usage: emptyUsage() }), error: `Execution close failed: ${String(error)}`, partial: true, stopReason: "error" };
      } finally {
        release?.(); signal.removeEventListener("abort", relay); controller.signal.removeEventListener("abort", abortChild);
        this.subagents.get(run.id)?.delete(node.id); this.nodeControllers.get(run.id)?.delete(node.id);
        this.hints.delete(`${run.id}/${node.id}/${attempt}`);
      }
    }
    current(); // Lost owners must not write attempt artifacts, even after drain.
    result ??= { exitCode: 1, signal: null, output: "", stderr: "", usage: emptyUsage(), error: "No execution result" };
    if (timedOut) { if (!node.autoContinueBlocked) node.cancelSource = "timeout"; result.error = `Timed out after ${node.timeoutMs}ms`; result.stopReason = "timeout"; result.partial = true; }
    node.attemptUsage = result.usage; node.usage = mergeUsage(node.usage, result.usage); node.accountedAttempt = attempt;
    run.usage = mergeUsage(run.usage, result.usage); run.unclaimedUsage = mergeUsage(run.unclaimedUsage, result.usage);
    node.stopReason = result.stopReason; node.partial = result.partial;
    const shutdown = this.closed && run.status === "paused";
    let error = result.error ?? (result.partial ? `Partial execution (${result.stopReason ?? "unknown"}); review evidence and retry explicitly` : result.exitCode !== 0 ? `Child exited ${result.exitCode}` : undefined);
    const pausedWaiter = controller.signal.reason === "pause" && run.status === "paused";
    let next: NodeStatus = (node.status as NodeStatus) === "cancelled" ? "cancelled" : shutdown || pausedWaiter ? "paused" : signal.aborted ? "cancelled" : error ? attempt <= node.retries ? "queued" : "failed" : "succeeded";
    // Capture the only worktree before output/checkpoint writes; defer deletion.
    if (node.worktree && ["ready", "running"].includes(node.worktree.phase)) {
      node.worktree = this.projectTrusted
        ? finalizeNodeWorktree(run.cwd, run.id, node.id, node.worktree, next, result.output, false)
        : { ...node.worktree, phase: "partial", cleanupStatus: "partial", cleanupError: "Host trust was revoked; automatic Git capture is disabled. Trust explicitly and manually preserve this worktree, or start a new non-worktree Agent." };
      node.worktreeHistory = [...(node.worktreeHistory ?? []), node.worktree];
      if (node.worktree.phase === "partial") { error = `Worktree handoff failed; preserved at ${node.worktree.path}: ${node.worktree.cleanupError}`; if (!["paused", "cancelled"].includes(next)) next = "failed"; }
    }
    try {
      current();
      node.outputPath = result.outputPath ?? putNodeOutput(run.cwd, run.id, node.id, attempt, result.output);
      node.outputBytes = result.outputPath ? fs.statSync(result.outputPath).size : Buffer.byteLength(result.output);
      node.output = boundedDisplay(result.output); node.outputTruncated = result.outputTruncated || node.output !== result.output;
      node.error = shutdown ? "Paused during Pi session shutdown" : pausedWaiter ? "Paused while waiting for shared quota; resume explicitly" : error;
      const finishedAt = Date.now();
      node.diagnosticPath = putDiagnosticExplanation(run.cwd, run.id, node.id, attempt, this.diagnosticExplanation(run, node, { ...result, error }, process.pid, finishedAt));
      this.boundEvidence(run);
      node.attemptResultPath = putAttemptResult(run.cwd, run.id, node.id, attempt, {
        schema: "pi-mesh.attempt-result/v1", runId: run.id, nodeId: node.id, attempt, status: next,
        committedRevision: run.revision + 1, pid: process.pid, startedAt: node.startedAt, finishedAt,
        exitCode: error ? 1 : result.exitCode, signal: result.signal, error: node.error, stderrTail: boundedDisplay(result.stderr), model: result.model,
        usage: result.usage, stopReason: result.stopReason, partial: result.partial, outputPath: node.outputPath, outputBytes: node.outputBytes, outputTruncated: node.outputTruncated,
      });
      const previous = node.status;
      transitionNode(node, next); node.finishedAt = ["queued", "paused"].includes(next) ? undefined : finishedAt;
      try { this.touch(run); } catch (failure) { node.status = previous; throw failure; }
    } catch (failure) {
      current();
      if (!["cancelled", "failed"].includes(node.status)) transitionNode(node, "failed");
      node.error = `Evidence/checkpoint delivery failed; preserve ${node.worktree?.path ?? node.outputPath ?? node.sessionFile ?? "execution evidence"}. Repair storage and recover explicitly. ${String(failure)}`;
      // A staged success result is not a successful delivery if its checkpoint
      // failed. Preserve its evidence but replace the public receipt when possible.
      try {
        const file = attemptResultFile(run.cwd, run.id, node.id, attempt);
        const staged = readJson<AttemptResult>(file);
        if (staged) putAttemptResult(run.cwd, run.id, node.id, attempt, { ...staged, status: node.status, error: node.error, exitCode: 1, partial: true, stopReason: "error" });
      } catch (error) { this.diagnostics.push(`Attempt failure receipt: ${String(error)}`); }
      this.touch(run);
    }
    // Only durable, non-shutdown results may remove their captured working copy.
    if (!shutdown && !preserveWorktree && node.worktree?.phase === "captured" && node.status === next) {
      current(); node.worktree = cleanupNodeWorktree(node.worktree);
      node.worktreeHistory![node.worktreeHistory!.length - 1] = node.worktree;
      this.touch(run);
    }
    this.debug(run, "attempt_finished", { nodeId: node.id, attempt, status: node.status });
    onUpdate?.(run);
  }

  private failNode(run: MeshRun, node: MeshNode, error: string, onUpdate?: (run: MeshRun) => void): void {
    this.assertOwner(run);
    transitionNode(node, "failed");
    node.error = error;
    node.finishedAt = Date.now();
    this.touch(run);
    onUpdate?.(run);
  }

  private nodePrompt(run: MeshRun, node: MeshNode): string {
    const dependencies = node.dependsOn.map((id) => run.nodes.find((candidate) => candidate.id === id)).filter((item): item is MeshNode => Boolean(item));
    const evidence = boundedDisplay(dependencies.map((dependency) => {
      const output = dependency.output ? truncateUtf8(dependency.output, 32 * 1024) : "";
      return [`### ${dependency.id}`, `Agent: ${dependency.agent}`, `Status: ${dependency.status}`,
        dependency.worktree?.finalCommit ? `Commit: ${dependency.worktree.finalCommit}` : "",
        dependency.worktree?.patchPath ? `Patch: ${dependency.worktree.patchPath}` : "",
        dependency.outputPath ? `Full output: ${dependency.outputPath}` : "",
        dependency.evidencePath ? `Full evidence/history: ${dependency.evidencePath} (follow previous links)` : "",
        output ? `Output:\n${output}` : ""].filter(Boolean).join("\n");
    }).join("\n\n"));
    const retryOutput = node.attempt > 1 && !node.sessionFile && node.output ? truncateUtf8(node.output, 4 * 1024, "tail") : "";
    const retry = node.attempt > 1 ? ["## Continue previous attempt", "Do not restart completed analysis or repeat successful steps. Inspect preserved evidence before editing.", node.sessionFile ? `Continue the recorded ${node.agent} session (runtime validates the original file).` : "New execution with repair context; the original session is unavailable.", `Current cwd: ${node.worktree?.cwd ?? node.cwd}. Previous absolute paths may have changed.`, node.error ? `Failure: ${truncateUtf8(node.error, 1024)}` : "", node.outputPath ? `Previous output: ${node.outputPath}` : "", node.evidencePath ? `Previous full evidence/history: ${node.evidencePath} (follow previous links)` : "", retryOutput ? `Previous output tail:\n${retryOutput}` : ""].filter(Boolean).join("\n") : "";
    const task = Buffer.byteLength(node.task) > 32 * 1024 ? `${truncateUtf8(node.task, 32 * 1024)}\n[Task truncated; inspect task in ${runFile(run.cwd, run.id)}]` : node.task;
    const boundedEvidence = Buffer.byteLength(evidence) > 20 * 1024 ? `${truncateUtf8(evidence, 20 * 1024 - 128)}\n[Dependency evidence truncated; inspect the run checkpoint and referenced full outputs]` : evidence;
    // Reserve repair instructions before dependency evidence; Runtime's 64KiB
    // task slice must not silently discard the continuation/cwd contract.
    return `${task}${retry ? `\n\n${truncateUtf8(retry, 8 * 1024)}` : ""}${evidence ? `\n\n## Direct dependency evidence\n${boundedEvidence}` : ""}`;
  }

  private validSessionFile(run: MeshRun, file: string, nodeId: string): boolean {
    try {
      const root = fs.realpathSync(path.join(run.cwd, CONFIG_DIR_NAME, "mesh", "sessions", "mesh", run.id, nodeId));
      const candidate = fs.realpathSync(file);
      const relative = path.relative(root, candidate);
      return path.extname(candidate) === ".jsonl" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    } catch { return false; }
  }

  private assertOwner(run: MeshRun): void {
    const expected = this.revisions.get(run.id);
    let disk: MeshRun | undefined;
    try { disk = readJson<MeshRun>(runFile(run.cwd, run.id)); }
    catch (error) { this.lost.add(run.id); this.controllers.get(run.id)?.abort(); for (const controller of this.nodeControllers.get(run.id)?.values() ?? []) controller.abort(); throw error; }
    if (this.lost.has(run.id) || !this.leases.get(run.id)?.isOwner() || (expected === undefined ? Boolean(disk) : disk?.revision !== expected)) {
      this.lost.add(run.id); this.controllers.get(run.id)?.abort();
      for (const controller of this.nodeControllers.get(run.id)?.values() ?? []) controller.abort();
      throw new Error(`Mesh ownership/revision lost for ${run.id}; drain then explicitly recover before modifying it`);
    }
  }

  private touch(run: MeshRun): void {
    this.assertOwner(run);
    const revision = run.revision;
    run.revision++; run.updatedAt = Date.now();
    try { this.persist(run); } catch (error) { run.revision = this.revisions.get(run.id) ?? revision; throw error; }
  }

  private boundEvidence(run: MeshRun): void {
    for (const node of run.nodes) {
      const evidence = { output: node.output, error: node.error, activity: node.activity, worktree: node.worktree, worktreeHistory: node.worktreeHistory };
      if (serializedBytes(evidence) <= INLINE_EVIDENCE_MAX_BYTES && (node.worktreeHistory?.length ?? 0) <= 1024) continue;
      const content = `${JSON.stringify({ schema: "pi-mesh.node-evidence/v1", runId: run.id, nodeId: node.id, attempt: node.attempt, previous: node.evidencePath, ...evidence }, null, 2)}\n`;
      const file = path.join(attemptDir(run.cwd, run.id, node.id, node.attempt), `evidence-${crypto.createHash("sha256").update(content).digest("hex")}.json`);
      // Never discard unique evidence before this immutable artifact is durable.
      atomicWriteContent(file, content);
      node.evidencePath = file;
      const preview = (text: string | undefined) => text === undefined ? undefined : truncateUtf8(text, 512);
      node.output = preview(node.output); node.error = preview(node.error);
      if (node.output !== evidence.output) node.outputTruncated = true;
      if (node.activity) node.activity = { ...node.activity, responseText: preview(node.activity.responseText)!, thinkingText: preview(node.activity.thinkingText)!, activeTools: node.activity.activeTools.slice(0, 8).map(text => preview(text)!) };
      if (node.worktree) node.worktree = { ...node.worktree, cleanupError: preview(node.worktree.cleanupError) };
      if (node.worktreeHistory) node.worktreeHistory = node.worktreeHistory.slice(-1).map(state => ({ ...state, cleanupError: preview(state.cleanupError) }));
    }
  }

  private persist(run: MeshRun): void {
    this.assertOwner(run);
    this.boundEvidence(run);
    validateRunState(run);
    if (serializedBytes(run) > CHECKPOINT_MAX_BYTES) throw new Error("Mesh serialized checkpoint budget exceeded; full evidence retained");
    try { atomicWriteCheckpoint(runFile(run.cwd, run.id), run, () => this.leases.get(run.id)?.isOwner() === true); }
    catch (error) {
      // Failed compensation may itself have renamed. Coordinate only our exact
      // payload under the original lease, never an unrelated advanced revision.
      if (this.leases.get(run.id)?.isOwner()) {
        try { if (fs.readFileSync(runFile(run.cwd, run.id), "utf8") === `${JSON.stringify(run, null, 2)}\n`) this.revisions.set(run.id, run.revision); } catch { /* uncertainty is retained in the error */ }
      }
      this.diagnostics.push(String(error)); throw error;
    }
    this.revisions.set(run.id, run.revision);
  }

  private ensureLease(run: MeshRun): void {
    if (this.lost.has(run.id)) throw new Error(`Mesh ${run.id} lost ownership; explicitly recover after drain`);
    const acquired = !this.leases.has(run.id);
    if (acquired) this.leases.set(run.id, acquireRunLease(run.cwd, run.id));
    try { this.assertOwner(run); } catch (error) { if (acquired) this.releaseLease(run.id); throw error; }
  }

  private releaseLease(runId: string): void {
    this.leases.get(runId)?.release();
    this.leases.delete(runId);
  }

  private recoveredAttemptResult(run: MeshRun, node: MeshNode): AttemptResult | undefined {
    const file = attemptResultFile(run.cwd, run.id, node.id, node.attempt);
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Unsafe/oversized attempt receipt ${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const result = readJson<AttemptResult>(file);
    if (!result) return undefined;
    if (result.schema !== "pi-mesh.attempt-result/v1" || result.runId !== run.id || result.nodeId !== node.id || result.attempt !== node.attempt
      || !["queued", "paused", "succeeded", "failed", "cancelled"].includes(result.status) || !Number.isFinite(result.finishedAt) || result.finishedAt < 0
      || !validUsage(result.usage) || !Number.isInteger(result.exitCode) || (result.signal !== null && typeof result.signal !== "string")
      || typeof result.stderrTail !== "string" || (result.outputPath !== undefined && (typeof result.outputPath !== "string" || result.outputPath.length > 4096))
      || [result.startedAt, result.outputBytes].some((v) => v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0))
      || [result.partial, result.outputTruncated].some((v) => v !== undefined && typeof v !== "boolean")
      || [result.model, result.error].some((v) => v !== undefined && typeof v !== "string")
      || (result.stopReason !== undefined && !["completed", "cancelled", "timeout", "maxTurns", "error"].includes(result.stopReason))
      || (result.committedRevision !== undefined && (!Number.isSafeInteger(result.committedRevision) || result.committedRevision < 1))) throw new Error(`Invalid attempt result state ${file}`);
    node.attemptResultPath = file;
    // Execution usage is independent of delivery confirmation, and its marker is
    // checkpointed by recovery before any subsequent attempt or claim can begin.
    if (node.accountedAttempt !== result.attempt) {
      node.attemptUsage = result.usage; node.usage = mergeUsage(node.usage, result.usage); node.accountedAttempt = result.attempt;
      run.usage = mergeUsage(run.usage, result.usage); run.unclaimedUsage = mergeUsage(run.unclaimedUsage, result.usage);
    }
    if (result.committedRevision === undefined || result.committedRevision > run.revision || ["queued", "paused"].includes(result.status)) return undefined;
    if (result.status === "succeeded" && (result.exitCode !== 0 || result.error || result.partial || result.stopReason && result.stopReason !== "completed")) throw new Error(`Unconfirmed successful delivery ${file}`);
    return result;
  }

  private applyRecoveredAttemptResult(run: MeshRun, node: MeshNode, result: AttemptResult): void {
    transitionNode(node, result.status);
    node.startedAt = result.startedAt;
    node.finishedAt = result.finishedAt;
    node.error = result.error;
    node.stopReason = result.stopReason; node.partial = result.partial;
    node.outputPath = result.outputPath;
    node.outputBytes = result.outputBytes;
    node.outputTruncated = result.outputTruncated;
    if (result.outputPath) {
      try {
        const candidate = fs.realpathSync(result.outputPath);
        const roots = [path.dirname(attemptResultFile(run.cwd, run.id, node.id, node.attempt)), path.join(os.tmpdir(), "pi-mesh-subagents", `${run.id}-${node.id}-${node.attempt}`)];
        if (!roots.some((root) => { const canonical = existingRealpath(root); if (!canonical) return false; const rel = path.relative(canonical, candidate); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); })) throw new Error("Unprovable legacy output reference; retained without reading Host files");
        node.output = readBoundedFile(candidate);
      } catch (error) {
        this.diagnostics.push(`Recovered output ${result.outputPath}: ${String(error)}. Reference retained; preview unavailable.`);
      }
    }
  }

  private diagnosticExplanation(run: MeshRun, node: MeshNode, result: ChildResult, pid: number | undefined, finishedAt: number): string {
    const cause = result.error ? result.error : "The in-process AgentSession completed successfully.";
    const action = result.error ? `Inspect ${node.attemptResultPath} and ${node.outputPath ?? "the AgentSession task/logs"}; then retry only after the cause is understood.` : "No action is required.";
    return `# Mesh attempt diagnostic\n\n- Run: ${run.id}\n- Node: ${node.id}\n- Agent: ${node.agent}\n- Attempt: ${node.attempt}\n- Status: ${node.status}\n- PID: ${pid ?? "unknown"}\n- Started: ${node.startedAt ? new Date(node.startedAt).toISOString() : "unknown"}\n- Finished: ${new Date(finishedAt).toISOString()}\n- Exit code: ${result.exitCode}\n- Signal: ${result.signal ?? "none"}\n- Model: ${result.model ?? "unknown"}\n- Output: ${node.outputPath ?? "none"}\n\n## Explanation\n\n${cause}${result.error ? `\n\nReported error: ${result.error}` : ""}${result.stderr.trim() ? `\n\nStderr tail:\n\n\`\`\`text\n${result.stderr}\n\`\`\`` : ""}\n\n## Suggested action\n\n${action}\n`;
  }

  private debug(run: MeshRun, event: string, details: Record<string, unknown> = {}): void {
    if (!this.settings.debug) return;
    appendDebugEvent(run.cwd, { timestamp: new Date().toISOString(), event, runId: run.id, revision: run.revision, ...details }, this.settings.debugMaxBytes);
  }

  private assertDepth(nodes: MeshNode[]): void {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const memo = new Map<string, number>();
    const depth = (id: string): number => {
      const known = memo.get(id);
      if (known) return known;
      const value = 1 + Math.max(0, ...(byId.get(id)?.dependsOn ?? []).map(depth));
      memo.set(id, value);
      return value;
    };
    const actual = Math.max(...nodes.map((node) => depth(node.id)));
    if (actual > this.settings.maxAgentDepth) throw new Error(`Agent dependency depth ${actual} exceeds maxAgentDepth ${this.settings.maxAgentDepth}`);
  }

  private assertAcyclic(nodes: MeshNode[]): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error(`Dependency cycle contains ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const node of nodes) visit(node.id);
  }
}
