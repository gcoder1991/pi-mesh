import * as crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentDefinition } from "./agents.ts";
import type { ChildResult, Usage } from "./pi-process.ts";
import { SubagentRuntime, type SubagentExecution } from "./subagent-runtime.ts";
import { acquireRunLease, type RunLease } from "./run-lease.ts";
import { appendDebugEvent, atomicWrite, attemptResultFile, listRunFiles, putAttemptResult, putDiagnosticExplanation, putNodeOutput, readJson, runFile } from "./store.ts";
import { defaultMeshSettings, type MeshSettings } from "./settings.ts";
import { transitionNode, transitionRun } from "./transitions.ts";
import { createNodeWorktree, finalizeNodeWorktree, prepareWorktreeRun, type WorktreeRunState, type WorktreeState } from "./worktree.ts";

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
  output?: string;
  outputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  attemptResultPath?: string;
  diagnosticPath?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  usage?: Usage;
  worktree?: WorktreeState;
  worktreeHistory?: WorktreeState[];
  activity?: { turns: number; toolUses: number; responseText: string; activeTools: string[]; usage: Usage };
}

export interface AttemptResult {
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
  status: RunStatus;
  cwd: string;
  maxConcurrency: number;
  maxNodes: number;
  failFast: boolean;
  operator: MeshOperator;
  revision: number;
  recoveryCount: number;
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

export class MeshManager {
  private readonly runs = new Map<string, MeshRun>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly processes = new Map<string, Map<string, ChildProcess>>();
  private readonly subagents = new Map<string, Map<string, SubagentExecution>>();
  private readonly nodeControllers = new Map<string, Map<string, AbortController>>();
  private readonly executions = new Map<string, Map<string, Promise<void>>>();
  private readonly loops = new Map<string, Promise<MeshRun>>();
  private readonly leases = new Map<string, RunLease>();
  private readonly resolveAgent: (name: string, cwd: string) => AgentDefinition | undefined;
  private readonly settings: MeshSettings;
  private readonly subagentRuntime: SubagentRuntime;

  constructor(resolveAgent: (name: string, cwd: string) => AgentDefinition | undefined, settings: MeshSettings = defaultMeshSettings) {
    this.resolveAgent = resolveAgent;
    this.settings = settings;
    this.subagentRuntime = new SubagentRuntime(settings);
  }

  recover(cwd: string): MeshRun[] {
    const root = fs.realpathSync(path.resolve(cwd));
    for (const file of listRunFiles(cwd)) {
      const run = readJson<MeshRun>(file);
      if (!run || run.schema !== "pi-mesh.run/v2" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run.id) || path.basename(file) !== `${run.id}.json` || fs.realpathSync(run.cwd) !== root
        || !Array.isArray(run.nodes) || run.nodes.some((node) => {
          const relative = path.relative(root, fs.realpathSync(node.cwd));
          return !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(node.id) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        })) continue;
      const interrupted = run.nodes.filter((node) => node.status === "running");
      if (interrupted.length) {
        this.ensureLease(run);
        run.recoveryCount++;
        for (const node of interrupted) {
          const result = this.recoveredAttemptResult(run, node);
          if (result) {
            this.applyRecoveredAttemptResult(node, result);
            if (node.worktree?.cleanupStatus === "pending") {
              node.worktree = finalizeNodeWorktree(run.cwd, run.id, node.id, node.worktree, node.status, node.output ?? "Recovered from attempt result");
              node.worktreeHistory = [...(node.worktreeHistory ?? []), node.worktree];
              if (node.worktree.cleanupStatus === "partial") {
                node.error = `Worktree handoff failed; preserved at ${node.worktree.path}: ${node.worktree.cleanupError}`;
                this.debug(run, "recovered_worktree_handoff_failed", { nodeId: node.id, attempt: node.attempt, path: node.worktree.path, error: node.worktree.cleanupError });
              }
            }
            this.debug(run, "attempt_result_recovered", { nodeId: node.id, attempt: node.attempt, status: node.status, attemptResultPath: node.attemptResultPath });
            continue;
          }
          if (node.worktree?.cleanupStatus === "pending") {
            node.worktree = finalizeNodeWorktree(run.cwd, run.id, node.id, node.worktree, "interrupted", "Recovered after host restart");
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
        run.updatedAt = Date.now();
        this.persist(run);
        if (run.status === "paused") this.releaseLease(run.id);
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

  steer(runId: string, nodeId: string, message: string): boolean {
    const node = this.runs.get(runId)?.nodes.find((item) => item.id === nodeId);
    const execution = this.subagents.get(runId)?.get(nodeId);
    if (!node || node.status !== "running" || !execution) return false;
    execution.steer(message);
    this.debug(this.runs.get(runId)!, "node_steered", { nodeId, attempt: node.attempt });
    return true;
  }

  cancel(runId: string, nodeId?: string): boolean {
    const run = this.runs.get(runId);
    if (!run || !["running", "paused"].includes(run.status)) return false;
    if (!nodeId) {
      transitionRun(run, "cancelling");
      this.controllers.get(runId)?.abort();
      for (const node of run.nodes) if (["queued", "paused"].includes(node.status)) transitionNode(node, "cancelled");
      this.touch(run);
      return true;
    }
    const node = run.nodes.find((item) => item.id === nodeId);
    if (!node || !["queued", "running", "paused"].includes(node.status)) return false;
    transitionNode(node, "cancelled");
    this.nodeControllers.get(runId)?.get(nodeId)?.abort();
    this.touch(run);
    return true;
  }

  pause(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return false;
    transitionRun(run, "paused");
    for (const node of run.nodes) if (node.status === "queued") transitionNode(node, "paused");
    this.touch(run);
    return true;
  }

  resume(runId: string): Promise<MeshRun> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "paused") throw new Error(`Mesh is not paused: ${runId}`);
    this.ensureLease(run);
    for (const node of run.nodes) if (node.status === "paused") transitionNode(node, "queued");
    transitionRun(run, "running");
    this.touch(run);
    return this.runLoop(run);
  }

  resumeRecovered(runId: string): Promise<MeshRun> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") throw new Error(`Mesh is not recoverable: ${runId}`);
    this.ensureLease(run);
    return this.runLoop(run);
  }

  async shutdown(): Promise<void> {
    const loops: Promise<MeshRun>[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== "running" && run.status !== "cancelling") continue;
      if (run.status === "running") {
        transitionRun(run, "paused");
        for (const node of run.nodes) if (node.status === "queued") transitionNode(node, "paused");
      }
      for (const node of run.nodes) if (node.status === "running") {
        transitionNode(node, "paused");
        node.error = "Paused during Pi session shutdown";
        node.startedAt = undefined;
      }
      this.controllers.get(run.id)?.abort();
      this.touch(run);
      const loop = this.loops.get(run.id);
      if (loop) loops.push(loop);
    }
    await Promise.allSettled(loops);
    for (const run of this.runs.values()) {
      if (run.status === "paused") this.touch(run);
      this.releaseLease(run.id);
    }
  }

  grow(runId: string, requester: string, tasks: MeshTask[]): MeshNode[] {
    const run = this.runs.get(runId);
    if (!run || !["running", "paused"].includes(run.status)) throw new Error(`Mesh is not active: ${runId}`);
    const requesterNode = run.nodes.find((node) => node.id === requester);
    if (!requesterNode) throw new Error(`Unknown requester node: ${requester}`);
    if (!['running', 'paused'].includes(requesterNode.status)) throw new Error(`Requester ${requester} is not active`);
    if (requesterNode.allowedSubagents !== "all") {
      const allowed = new Set((requesterNode.allowedSubagents ?? []).map((name) => name.toLowerCase()));
      const denied = tasks.map((task) => task.agent).filter((name) => !allowed.has(name.toLowerCase()));
      if (denied.length) throw new Error(`Requester ${requester} cannot grow agents: ${[...new Set(denied)].join(", ")}`);
    }
    const added = this.prepareNodes(run, tasks, true, requester);
    if (run.nodes.length + added.length > run.maxNodes) throw new Error(`Growth exceeds maxNodes ${run.maxNodes}`);
    this.assertAcyclic([...run.nodes, ...added]);
    this.assertDepth([...run.nodes, ...added]);
    run.nodes.push(...added);
    this.touch(run);
    return added;
  }

  create(options: StartRunOptions): MeshRun {
    const maxConcurrency = options.maxConcurrency ?? this.settings.maxConcurrentAgents;
    const maxNodes = options.maxNodes ?? this.settings.maxNodes;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > this.settings.maxConcurrentAgents) throw new Error(`maxConcurrency must be 1-${this.settings.maxConcurrentAgents}`);
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > this.settings.maxNodes) throw new Error(`maxNodes must be 1-${this.settings.maxNodes}`);
    if (options.tasks.length < 1 || options.tasks.length > Math.min(32, maxNodes)) throw new Error("tasks must contain 1-32 items within maxNodes");

    const now = Date.now();
    const run: MeshRun = {
      schema: "pi-mesh.run/v2",
      id: crypto.randomUUID(),
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
    if (options.worktree) run.worktree = prepareWorktreeRun(run.cwd, run.nodes.map((node) => node.cwd), options.worktreeSetupHook);
    this.ensureLease(run);
    this.runs.set(run.id, run);
    this.persist(run);
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
        model: task.model, timeoutMs: task.timeoutMs, retries: task.retries ?? 0, attempt: 0,
        dynamic, requestedBy: requester, allowedSubagents: agent.allowedSubagents, integration: task.integration, status: run.status === "paused" ? "paused" : "queued",
      };
    });
    for (const node of nodes) for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new Error(`Task ${node.id} depends on unknown task ${dependency}`);
    return nodes;
  }

  private runLoop(run: MeshRun, externalSignal?: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<MeshRun> {
    const existing = this.loops.get(run.id);
    if (existing) return existing;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", relayAbort, { once: true });
    this.controllers.set(run.id, controller);
    this.processes.set(run.id, new Map());
    this.subagents.set(run.id, new Map());
    this.nodeControllers.set(run.id, new Map());
    this.executions.set(run.id, new Map());

    let lastUpdateAt = 0;
    let pendingUpdate: NodeJS.Timeout | undefined;
    const emitUpdate = (force = false) => {
      if (!onUpdate) return;
      const now = Date.now();
      const remaining = 500 - (now - lastUpdateAt);
      if (!force && remaining > 0) {
        if (!pendingUpdate) {
          pendingUpdate = setTimeout(() => { pendingUpdate = undefined; lastUpdateAt = Date.now(); onUpdate(run); }, remaining);
          pendingUpdate.unref?.();
        }
        return;
      }
      if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = undefined; }
      lastUpdateAt = now;
      onUpdate(run);
    };

    const loop = (async () => {
      try {
        while (run.status === "running" || run.status === "cancelling") {
          const active = this.executions.get(run.id)?.size ?? 0;
          const ready = run.nodes.filter((node) => node.status === "queued" && node.dependsOn.every((id) => run.nodes.find((candidate) => candidate.id === id)?.status === "succeeded"));
          const blocked = run.nodes.filter((node) => node.status === "queued" && node.dependsOn.some((id) => ["failed", "cancelled", "skipped"].includes(run.nodes.find((candidate) => candidate.id === id)?.status ?? "")));
          for (const node of blocked) transitionNode(node, "skipped");
          for (const node of ready.slice(0, Math.max(0, run.maxConcurrency - active))) {
            const notify = () => emitUpdate();
            const execution = this.executeNode(run, node, controller.signal, notify).catch((error) => {
              if (node.status !== "cancelled") this.failNode(run, node, error instanceof Error ? error.message : String(error), notify);
            });
            this.executions.get(run.id)?.set(node.id, execution);
            void execution.finally(() => this.executions.get(run.id)?.delete(node.id));
          }
          if (blocked.length || ready.length) this.touch(run);
          emitUpdate();

          if (controller.signal.aborted) {
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) transitionNode(node, "cancelled");
            transitionRun(run, "cancelled");
            break;
          }
          if (run.operator === "race" && run.nodes.some((node) => node.status === "succeeded")) {
            controller.abort();
            for (const node of run.nodes) if (["queued", "running"].includes(node.status)) transitionNode(node, "cancelled");
            transitionRun(run, "succeeded");
            break;
          }
          if (run.failFast && run.nodes.some((node) => node.status === "failed")) {
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
        if (run.status !== "paused") run.finishedAt = Date.now();
        this.controllers.delete(run.id);
        this.processes.delete(run.id);
        this.subagents.delete(run.id);
        this.nodeControllers.delete(run.id);
        this.executions.delete(run.id);
        this.loops.delete(run.id);
        externalSignal?.removeEventListener("abort", relayAbort);
        this.touch(run);
        this.releaseLease(run.id);
        emitUpdate(true);
      }
      return run;
    })();
    this.loops.set(run.id, loop);
    return loop;
  }

  private async executeNode(run: MeshRun, node: MeshNode, signal: AbortSignal, onUpdate?: (run: MeshRun) => void): Promise<void> {
    if (node.status !== "queued") return;
    const agent = this.resolveAgent(node.agent, node.cwd);
    if (!agent) return void this.failNode(run, node, `Unknown agent: ${node.agent}`, onUpdate);
    node.attempt++;
    const attempt = node.attempt;
    if (run.worktree) {
      try {
        const parentCommits = [...new Set(node.dependsOn.map((id) => run.nodes.find((candidate) => candidate.id === id)?.worktree?.finalCommit).filter((commit): commit is string => Boolean(commit && commit !== run.worktree!.baseCommit)))];
        if (parentCommits.length > 1 && !node.integration) throw new Error(`Task ${node.id} has multiple writer dependencies; mark it integration: true to merge their patches explicitly`);
        node.worktree = createNodeWorktree(run.worktree, run.id, node.id, node.attempt, node.cwd, parentCommits.length === 1 ? parentCommits[0] : undefined);
      } catch (error) {
        return void this.failNode(run, node, error instanceof Error ? error.message : String(error), onUpdate);
      }
    }
    if (node.worktree) node.worktree.phase = "running";
    transitionNode(node, "running");
    node.startedAt = Date.now();
    node.finishedAt = undefined;
    node.activity = { turns: 0, toolUses: 0, responseText: "", activeTools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
    this.touch(run);
    onUpdate?.(run);

    const timeoutController = new AbortController();
    this.nodeControllers.get(run.id)?.set(node.id, timeoutController);
    const abort = () => timeoutController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = node.timeoutMs ? setTimeout(abort, node.timeoutMs) : undefined;
    timer?.unref?.();
    let child: SubagentExecution;
    try {
      child = this.subagentRuntime.start(agent, {
        id: `${run.id}-${node.id}-${attempt}`,
        cwd: node.worktree?.cwd ?? node.cwd,
        prompt: this.nodePrompt(run, node),
        model: node.model,
        thinking: agent.thinking,
        maxTurns: agent.maxTurns,
        env: { PI_MESH_RUN_ID: run.id, PI_MESH_NODE_ID: node.id, PI_MESH_ATTEMPT: String(attempt), PI_MESH_ROOT: run.cwd },
        onEvent: (event) => this.trackActivity(node, event),
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      return void this.failNode(run, node, error instanceof Error ? error.message : String(error), onUpdate);
    }
    const childPid = child.session.process.pid;
    this.processes.get(run.id)?.set(node.id, child.session.process);
    this.subagents.get(run.id)?.set(node.id, child);
    const abortChild = () => child.abort();
    timeoutController.signal.addEventListener("abort", abortChild, { once: true });
    const result = await child.completion;
    timeoutController.signal.removeEventListener("abort", abortChild);
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    this.processes.get(run.id)?.delete(node.id);
    this.subagents.get(run.id)?.delete(node.id);
    void child.close();
    this.nodeControllers.get(run.id)?.delete(node.id);

    if (node.attempt !== attempt || !["running", "cancelled"].includes(node.status as NodeStatus)) {
      this.debug(run, "stale_attempt_result", { nodeId: node.id, attempt, currentAttempt: node.attempt, currentStatus: node.status, exitCode: result.exitCode, signal: result.signal, error: result.error });
      return;
    }

    if (result.output) {
      node.outputPath = putNodeOutput(run.cwd, run.id, node.id, attempt, result.output);
      node.outputBytes = Buffer.byteLength(result.output);
      node.outputTruncated = node.outputBytes > 200 * 1024;
      node.output = node.outputTruncated ? `${Buffer.from(result.output).subarray(0, 200 * 1024).toString("utf8")}\n[truncated; full output: ${node.outputPath}]` : result.output;
    }
    if ((node.status as NodeStatus) === "cancelled" || signal.aborted) {
      if ((node.status as NodeStatus) === "running") transitionNode(node, "cancelled");
    } else if (result.error && attempt <= node.retries) {
      transitionNode(node, "queued");
      node.error = result.error;
    } else if (result.error) this.failNode(run, node, result.error, onUpdate);
    else {
      transitionNode(node, "succeeded");
      node.error = undefined;
    }
    const finishedAt = Date.now();
    node.attemptResultPath = putAttemptResult(run.cwd, run.id, node.id, attempt, {
      schema: "pi-mesh.attempt-result/v1",
      runId: run.id,
      nodeId: node.id,
      attempt,
      status: node.status,
      pid: childPid,
      startedAt: node.startedAt,
      finishedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.error,
      stderrTail: result.stderr,
      model: result.model,
      usage: result.usage,
      outputPath: node.outputPath,
      outputBytes: node.outputBytes,
      outputTruncated: node.outputTruncated,
    });
    node.diagnosticPath = putDiagnosticExplanation(run.cwd, run.id, node.id, attempt, this.diagnosticExplanation(run, node, result, childPid, finishedAt));
    this.debug(run, "attempt_finished", { nodeId: node.id, attempt, status: node.status, exitCode: result.exitCode, signal: result.signal, error: result.error, attemptResultPath: node.attemptResultPath, diagnosticPath: node.diagnosticPath });
    if (node.worktree) {
      node.worktree = finalizeNodeWorktree(run.cwd, run.id, node.id, node.worktree, node.status, result.output);
      node.worktreeHistory = [...(node.worktreeHistory ?? []), node.worktree];
      if (node.worktree.cleanupStatus === "partial") {
        if (node.status === "queued") transitionNode(node, "failed");
        else if (!["failed", "cancelled"].includes(node.status)) {
          this.debug(run, "worktree_handoff_after_terminal", { nodeId: node.id, attempt: node.attempt, previousStatus: node.status });
        }
        node.error = `Worktree handoff failed; preserved at ${node.worktree.path}: ${node.worktree.cleanupError}`;
      }
    }
    node.usage = result.usage;
    node.finishedAt = node.status === "queued" ? undefined : Date.now();
    this.touch(run);
    onUpdate?.(run);
  }

  private trackActivity(node: MeshNode, event: any): void {
    const activity = node.activity ??= { turns: 0, toolUses: 0, responseText: "", activeTools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
    if (event.type === "turn_start") activity.turns++;
    if (event.type === "tool_execution_start") { activity.toolUses++; activity.activeTools = [...activity.activeTools.filter((name) => name !== event.toolName), event.toolName].slice(-3); }
    if (event.type === "tool_execution_end") activity.activeTools = activity.activeTools.filter((name) => name !== event.toolName);
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") activity.responseText = `${activity.responseText}${event.assistantMessageEvent.delta ?? ""}`.slice(-160);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const usage = event.message.usage; activity.turns = Math.max(activity.turns, activity.usage.turns + 1); activity.usage.turns++;
      activity.usage.input += usage?.input ?? 0; activity.usage.output += usage?.output ?? 0; activity.usage.cacheRead += usage?.cacheRead ?? 0; activity.usage.cacheWrite += usage?.cacheWrite ?? 0;
      activity.usage.cost += usage?.cost?.total ?? 0; activity.usage.costInput = (activity.usage.costInput ?? 0) + (usage?.cost?.input ?? 0); activity.usage.costOutput = (activity.usage.costOutput ?? 0) + (usage?.cost?.output ?? 0);
      activity.usage.costCacheRead = (activity.usage.costCacheRead ?? 0) + (usage?.cost?.cacheRead ?? 0); activity.usage.costCacheWrite = (activity.usage.costCacheWrite ?? 0) + (usage?.cost?.cacheWrite ?? 0);
    }
  }

  private failNode(run: MeshRun, node: MeshNode, error: string, onUpdate?: (run: MeshRun) => void): void {
    transitionNode(node, "failed");
    node.error = error;
    node.finishedAt = Date.now();
    this.touch(run);
    onUpdate?.(run);
  }

  private nodePrompt(run: MeshRun, node: MeshNode): string {
    const dependencies = node.dependsOn.map((id) => run.nodes.find((candidate) => candidate.id === id)).filter((item): item is MeshNode => Boolean(item));
    const evidence = dependencies.map((dependency) => {
      const output = dependency.output ? Buffer.from(dependency.output).subarray(0, 32 * 1024).toString("utf8") : "";
      return [`### ${dependency.id}`, `Agent: ${dependency.agent}`, `Status: ${dependency.status}`,
        dependency.worktree?.finalCommit ? `Commit: ${dependency.worktree.finalCommit}` : "",
        dependency.worktree?.patchPath ? `Patch: ${dependency.worktree.patchPath}` : "",
        dependency.outputPath ? `Full output: ${dependency.outputPath}` : "",
        output ? `Output:\n${output}` : ""].filter(Boolean).join("\n");
    }).join("\n\n");
    const retry = node.attempt > 1 && node.error ? `\n\n## Previous attempt failed\n${node.error}` : "";
    return `${node.task}${evidence ? `\n\n## Direct dependency evidence\n${evidence}` : ""}${retry}`;
  }

  private touch(run: MeshRun): void {
    run.revision++;
    run.updatedAt = Date.now();
    this.persist(run);
  }

  private persist(run: MeshRun): void {
    atomicWrite(runFile(run.cwd, run.id), run);
  }

  private ensureLease(run: MeshRun): void {
    if (!this.leases.has(run.id)) this.leases.set(run.id, acquireRunLease(run.cwd, run.id));
  }

  private releaseLease(runId: string): void {
    this.leases.get(runId)?.release();
    this.leases.delete(runId);
  }

  private recoveredAttemptResult(run: MeshRun, node: MeshNode): AttemptResult | undefined {
    const file = attemptResultFile(run.cwd, run.id, node.id, node.attempt);
    const result = readJson<AttemptResult>(file);
    if (!result) return undefined;
    if (result.schema !== "pi-mesh.attempt-result/v1" || result.runId !== run.id || result.nodeId !== node.id || result.attempt !== node.attempt
      || !["queued", "succeeded", "failed", "cancelled"].includes(result.status) || !Number.isFinite(result.finishedAt)) throw new Error(`Invalid attempt result state ${file}`);
    node.attemptResultPath = file;
    return result.status === "queued" ? undefined : result;
  }

  private applyRecoveredAttemptResult(node: MeshNode, result: AttemptResult): void {
    transitionNode(node, result.status);
    node.startedAt = result.startedAt;
    node.finishedAt = result.finishedAt;
    node.error = result.error;
    node.usage = result.usage;
    node.outputPath = result.outputPath;
    node.outputBytes = result.outputBytes;
    node.outputTruncated = result.outputTruncated;
    if (result.outputPath) {
      try {
        const output = fs.readFileSync(result.outputPath, "utf8");
        node.output = result.outputTruncated ? `${Buffer.from(output).subarray(0, 200 * 1024).toString("utf8")}\n[truncated; full output: ${result.outputPath}]` : output;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private diagnosticExplanation(run: MeshRun, node: MeshNode, result: ChildResult, pid: number | undefined, finishedAt: number): string {
    const cause = result.error ? result.signal ? `The child process ended with signal ${result.signal}.` : result.exitCode !== 0 ? `The child process exited with code ${result.exitCode}.` : result.error : "The child completed successfully.";
    const action = result.error ? `Inspect ${node.attemptResultPath} and ${node.outputPath ?? "the child task/logs"}; then retry only after the cause is understood.` : "No action is required.";
    return `# Mesh attempt diagnostic\n\n- Run: ${run.id}\n- Node: ${node.id}\n- Agent: ${node.agent}\n- Attempt: ${node.attempt}\n- Status: ${node.status}\n- PID: ${pid ?? "unknown"}\n- Started: ${node.startedAt ? new Date(node.startedAt).toISOString() : "unknown"}\n- Finished: ${new Date(finishedAt).toISOString()}\n- Exit code: ${result.exitCode}\n- Signal: ${result.signal ?? "none"}\n- Model: ${result.model ?? "unknown"}\n- Output: ${node.outputPath ?? "none"}\n\n## Explanation\n\n${cause}${result.error ? `\n\nReported error: ${result.error}` : ""}${result.stderr.trim() ? `\n\nStderr tail:\n\n\`\`\`text\n${result.stderr}\n\`\`\`` : ""}\n\n## Suggested action\n\n${action}\n`;
  }

  private debug(run: MeshRun, event: string, details: Record<string, unknown> = {}): void {
    if (!this.settings.debug) return;
    appendDebugEvent(run.cwd, { timestamp: new Date().toISOString(), event, runId: run.id, revision: run.revision, ...details });
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
