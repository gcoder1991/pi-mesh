import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BUNDLED_AGENTS_DIR, discoverAgents, type AgentDefinition } from "./agents.ts";
import type { ChildResult } from "./pi-process.ts";
import { boundedDisplay, readBoundedFile, emptyUsage, mergeUsage, trackActivity, type Usage, type AgentActivity } from "./runtime-utils.ts";
import { SubagentRuntime, type SubagentExecution, type SubagentSession } from "./subagent-runtime.ts";
import { FleetLimiter } from "./fleet-limiter.ts";
import type { MeshSettings } from "./settings.ts";
import { atomicWriteCheckpoint, putAgentOutput, readJson } from "./store.ts";
import { cleanupNodeWorktree, createNodeWorktree, finalizeNodeWorktree, prepareWorktreeRun, type WorktreeState } from "./worktree.ts";

export type SessionAgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export interface SessionAgentRecord {
  id: string;
  agent: AgentDefinition;
  description: string;
  prompt: string;
  cwd: string;
  status: SessionAgentStatus;
  createdAt: number;
  completedAt?: number;
  result?: ChildResult;
  outputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  error?: string;
  execution?: SubagentExecution | SubagentSession;
  promise?: Promise<void>;
  worktree?: WorktreeState;
  launch?: { model?: string; thinking?: string; maxTurns?: number; persistent?: boolean; transcript?: boolean; transcriptPath?: string; parentContext?: string; sessionDir?: string; sessionFile?: string };
  activity?: AgentActivity;
  generation?: number;
  settling?: boolean;
  ready?: boolean;
  foreground?: boolean;
  stoppedByUser?: boolean;
  autoContinueBlocked?: boolean;
  abortVersion?: number;
  abortSource?: "user" | "unknown" | "shutdown" | "timeout";
  recoveryDiagnostic?: string;
  cumulativeUsage?: Usage;
  unclaimedUsage?: Usage;
  claimedGeneration?: number;
  previous?: { generation: number; status: SessionAgentStatus; outputPath?: string; sessionFile?: string; stopReason?: ChildResult["stopReason"] };
  directions?: Array<{ generation: number; message: string }>;
  receipts?: Array<{ key: string; generation: number; disposition: string }>;

}

const MAX_RECORDS = 1024;

export class SessionAgentManager {
  private readonly records = new Map<string, SessionAgentRecord>();
  private runtime: SubagentRuntime;
  private readonly modelRegistry?: ModelRegistry;
  private readonly cwd: string;
  private readonly registryFile: string;
  private readonly sessionRoot: string;
  private projectTrusted: boolean;
  private settings: MeshSettings;
  private readonly limiter: FleetLimiter;
  private readonly controllers = new Map<string, AbortController>();
  private readonly continuations = new Set<string>();
  private readonly waitingDirections = new Map<string, number>();
  private closed = false;
  private shutdownPromise?: Promise<void>;
  readonly diagnostics: Array<{ id: string; message: string; cause?: unknown }> = [];
  private onComplete?: (record: SessionAgentRecord) => void;
  private onStart?: (record: SessionAgentRecord) => void;

  constructor(settings: MeshSettings, cwd: string, onComplete?: (record: SessionAgentRecord) => void, sessionId = "default", limiter?: FleetLimiter, modelRegistry?: ModelRegistry, projectTrusted = false) {
    this.modelRegistry = modelRegistry;
    this.runtime = new SubagentRuntime(settings, modelRegistry ? { modelRegistry, projectTrusted } : undefined);
    this.cwd = fs.realpathSync(path.resolve(cwd));
    const safeSessionId = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    this.registryFile = path.join(this.cwd, CONFIG_DIR_NAME, "mesh", "subagents", `${safeSessionId}.json`);
    this.sessionRoot = path.join(this.cwd, CONFIG_DIR_NAME, "mesh", "sessions", "direct", safeSessionId);
    this.projectTrusted = projectTrusted;
    this.settings = settings;
    this.limiter = limiter ?? new FleetLimiter(settings.maxConcurrentAgents);
    this.onComplete = onComplete;
    this.restore();
  }

  updateAuthorization(settings: MeshSettings, projectTrusted: boolean): void {
    if (JSON.stringify(settings) === JSON.stringify(this.settings) && projectTrusted === this.projectTrusted) return;
    this.runtime = new SubagentRuntime(settings, this.modelRegistry ? { modelRegistry: this.modelRegistry, projectTrusted } : undefined);
    this.settings = settings; this.projectTrusted = projectTrusted;
  }
  setOnComplete(value: (record: SessionAgentRecord) => void): void { this.onComplete = value; }
  setOnStart(value: (record: SessionAgentRecord) => void): void { this.onStart = value; }
  list(): SessionAgentRecord[] { return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt); }
  private captureResult(record: SessionAgentRecord, result: ChildResult): void {
    record.outputBytes = result.outputPath ? (() => { try { return fs.statSync(result.outputPath).size; } catch { return Buffer.byteLength(result.output); } })() : Buffer.byteLength(result.output);
    const preview = boundedDisplay(result.output);
    record.outputTruncated = result.outputTruncated || preview !== result.output;
    // Runtime output is already a preview when outputPath exists. Never overwrite its artifact.
    record.outputPath = result.outputPath ?? (record.outputTruncated ? putAgentOutput(this.cwd, record.id, result.output) : undefined);
    record.result = { ...result, output: preview, outputPath: record.outputPath, outputTruncated: record.outputTruncated };
    record.cumulativeUsage = mergeUsage(record.cumulativeUsage, result.usage);
    record.unclaimedUsage = mergeUsage(record.unclaimedUsage, result.usage);
  }
  claimUsage(id: string, generation?: number): Usage | undefined {
    const record = this.records.get(id);
    if (!record?.unclaimedUsage || record.settling || ["queued", "running"].includes(record.status)) return undefined;
    let usage = record.unclaimedUsage;
    const unclaimed = record.unclaimedUsage, claimed = record.claimedGeneration;
    if (generation !== undefined) {
      if (generation !== record.generation || record.claimedGeneration === generation || !record.result) return undefined;
      usage = record.result.usage;
      const remainder = { ...record.unclaimedUsage };
      for (const key of Object.keys(usage) as Array<keyof Usage>) remainder[key] = Math.max(0, (remainder[key] ?? 0) - (usage[key] ?? 0));
      record.unclaimedUsage = remainder.turns ? remainder : undefined;
    } else record.unclaimedUsage = undefined;
    record.claimedGeneration = record.generation;
    try { this.persist(); } catch (error) { record.unclaimedUsage = unclaimed; record.claimedGeneration = claimed; throw error; }
    return usage;
  }
  nextAction(record: SessionAgentRecord): string {
    if (record.settling) return "Wait for execution close before continuing.";
    if (record.status === "queued") return `Wait with get_subagent_result(agent_id="${record.id}", wait=true).`;
    if (record.status === "running") return `Use steer_subagent(agent_id="${record.id}", message="...").`;
    if (record.worktree) return "Manually review and accept the worktree commit/patch; start a new Agent for further work.";
    if (record.autoContinueBlocked) return `User authorization required: /agents resume ${record.id} <instruction>.`;
    if (!(record.launch?.persistent ?? record.agent.persistSession)) return "Start a new Agent; this execution was nonpersistent.";
    if (record.recoveryDiagnostic || !record.launch?.sessionFile || !fs.existsSync(record.launch.sessionFile)) return "Restore the original child session file at its recorded safe path; otherwise start a new Agent (do not fabricate a resume file).";
    return `Use Agent(resume="${record.id}", prompt="...", description="${record.description}", subagent_type="${record.agent.name}").`;
  }
  private transcriptPath(id: string, transcript?: boolean): string | undefined {
    return transcript === false ? undefined : path.join(this.cwd, CONFIG_DIR_NAME, "mesh", "transcripts", `${id}.jsonl`);
  }
  private canonical(file: string): string {
    try { return fs.realpathSync(file); } catch { const parent = path.dirname(file); if (parent === file) throw new Error(`Invalid path: ${file}`); return path.join(this.canonical(parent), path.basename(file)); }
  }
  private inside(file: string, root: string): boolean { const relative = path.relative(this.canonical(root), this.canonical(file)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
  get(id: string): SessionAgentRecord | undefined { return this.records.get(id); }

  spawn(agent: AgentDefinition, prompt: string, description: string, cwd: string, options: { model?: string; thinking?: string; maxTurns?: number; persistent?: boolean; transcript?: boolean; parentContext?: string; worktree?: boolean; sessionDir?: string }): SessionAgentRecord {
    if (this.closed) throw new Error("Agent manager is shut down; start a new Host session.");
    if (options.worktree && !this.projectTrusted) throw new Error("Worktree requires current Host project trust; trust explicitly or start a new non-worktree Agent.");
    if (this.records.size >= MAX_RECORDS) throw new Error("Agent record limit reached (1024). Preserve recovery files and start a new Host session; records are never silently evicted.");
    if (fs.realpathSync(cwd) !== this.cwd) throw new Error("Agent cwd escapes project root");
    this.validateResources(agent);
    const id = crypto.randomUUID();
    const sessionDir = path.join(this.sessionRoot, id);
    if (this.canonical(sessionDir) !== sessionDir) throw new Error("Unsafe direct session directory (symlink)");
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    let worktree: WorktreeState | undefined;
    if (options.worktree) worktree = createNodeWorktree(prepareWorktreeRun(cwd, [cwd]), "agent", id, 1, cwd);
    const transcriptPath = this.transcriptPath(id, options.transcript ?? agent.outputTranscript);
    const record: SessionAgentRecord = { id, agent, description, prompt, cwd, status: "queued", createdAt: Date.now(), worktree, launch: { model: options.model, thinking: options.thinking, maxTurns: options.maxTurns, persistent: options.persistent, transcript: options.transcript, transcriptPath, parentContext: options.parentContext, sessionDir } };
    this.records.set(id, record);
    this.runRecord(record, prompt, false);
    return record;
  }

  private validateResources(agent: AgentDefinition): void {
    const missing = [...(agent.isolated ? [] : agent.extensions ?? []).filter((name) => !this.settings.childExtensions[name]).map((name) => `extension:${name}`), ...(agent.isolated ? [] : agent.skills ?? []).filter((name) => !this.settings.childSkills[name]).map((name) => `skill:${name}`)];
    if (missing.length) throw new Error(`Unapproved child resources: ${missing.join(", ")}`);
  }

  private runRecord(record: SessionAgentRecord, prompt: string, resume: boolean): Promise<void> {
    const generation = (record.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Agent generation limit reached; start a new Agent.");
    record.previous = record.generation ? { generation: record.generation, status: record.status, outputPath: record.outputPath, sessionFile: record.launch?.sessionFile, stopReason: record.result?.stopReason } : undefined;
    record.generation = generation; record.status = "queued"; record.settling = false; record.ready = false;
    record.result = undefined; record.outputPath = undefined; record.outputBytes = undefined; record.outputTruncated = undefined;
    record.error = undefined; record.completedAt = undefined; record.abortSource = undefined;
    record.activity = { turns: 0, toolUses: 0, responseText: "", thinkingText: "", activeTools: [], usage: emptyUsage() };
    const controller = new AbortController(); this.controllers.set(record.id, controller);
    // Admission must be durable before any child/extension side effects begin.
    try { this.persist(); } catch (error) {
      controller.abort(); this.controllers.delete(record.id);
      record.status = "failed"; record.completedAt = Date.now();
      record.error = `Cannot persist Agent ${record.id}; no child was started. Fix checkpoint storage before retrying.${record.worktree ? ` Worktree preserved at ${record.worktree.path}.` : ""} ${String(error)}`;
      record.promise = Promise.resolve();
      try { this.persist(); } catch (repair) { this.diagnostics.push({ id: record.id, message: `Admission repair uncertain: ${String(repair)}` }); }
      throw new Error(record.error, { cause: error });
    }
    // Established synchronously while queued; never replaced in this generation.
    record.promise = (async () => {
      let release: (() => void) | undefined;
      let execution: SubagentExecution | SubagentSession | undefined;
      const current = () => record.generation === generation;
      try {
        release = await this.limiter.acquire(controller.signal);
        if (!current() || controller.signal.aborted || this.closed) return;
        this.validateResources(record.agent);
        if (record.worktree && !this.projectTrusted) throw new Error("Worktree requires current Host project trust; trust explicitly or start a new non-worktree Agent.");
        if (record.agent.source === "project" && !this.projectTrusted) throw new Error("Project agent is no longer trusted; use mesh list_agents.");
        record.status = "running";
        const options = { id: record.id, cwd: record.worktree?.cwd ?? record.cwd, ...record.launch, prompt,
          onEvent: (event: any) => { if (current()) trackActivity(record, event); },
          onReady: (ready: { sessionFile?: string }) => {
            if (!current()) return;
            record.ready = true;
            if (ready.sessionFile && record.launch) { if (!this.inside(ready.sessionFile, record.launch.sessionDir!) || path.extname(ready.sessionFile) !== ".jsonl") throw new Error("Unsafe ready session file"); record.launch.sessionFile = ready.sessionFile; this.persist(); }
          },
        };
        execution = resume ? this.runtime.connect(record.agent, options) : this.runtime.start(record.agent, options);
        record.execution = execution;
        const completion = resume ? execution.session.prompt(prompt) : (execution as SubagentExecution).completion;
        void execution.ready.then(() => {
          if (!current() || controller.signal.aborted) return;
          for (const direction of record.directions?.splice(0) ?? []) if (direction.generation === generation) execution!.steer(direction.message);
        }).catch(() => {});
        this.onStart?.(record); this.persist();
        const result = await completion;
        if (!current()) return;
        if (record.launch && execution.sessionFile) record.launch.sessionFile = execution.sessionFile;
        this.captureResult(record, result);
        const next = (record.status as SessionAgentStatus) === "stopped" ? "stopped" : result.error || result.exitCode !== 0 ? "failed" : result.partial ? "stopped" : "completed";
        if (record.worktree) {
          if (!this.projectTrusted) throw new Error(`Host trust was revoked; automatic Git capture is disabled. Worktree preserved at ${record.worktree.path}; trust explicitly and preserve it before a new Agent.`);
          record.worktree = finalizeNodeWorktree(record.cwd, "agent", record.id, record.worktree, next, result.output, false);
          if (record.worktree.phase === "partial") throw new Error(`Worktree handoff failed; preserved at ${record.worktree.path}: ${record.worktree.cleanupError}`);
        }
        if ((record.status as SessionAgentStatus) !== "stopped") record.status = next;
      } catch (error) {
        if (current() && record.status !== "stopped") { record.status = "failed"; record.error = error instanceof Error ? error.message : String(error); }
        if (current() && !record.result && record.activity?.usage.turns) {
          this.captureResult(record, { exitCode: 1, signal: null, output: record.activity.responseText, stderr: "", usage: record.activity.usage, error: record.error, stopReason: "error", partial: true });
        }
      } finally {
        if (current()) {
          record.settling = true;
          if (!record.result) this.captureResult(record, { exitCode: 1, signal: null, output: "", stderr: "", usage: emptyUsage(), error: record.error ?? "Child cancelled before launch", stopReason: record.abortSource === "timeout" ? "timeout" : record.status === "stopped" ? "cancelled" : "error", partial: true });
        }
        try { await execution?.close(); }
        catch (error) { if (current()) { record.error = `Execution close failed: ${String(error)}`; record.status = "failed"; } }
        finally {
          release?.();
          if (current()) {
            record.execution = undefined; record.settling = false; record.completedAt = Date.now();
            record.directions = []; this.controllers.delete(record.id);
            try {
              this.persist();
              if (record.worktree?.phase === "captured" && record.status !== "stopped") { record.worktree = cleanupNodeWorktree(record.worktree); this.persist(); }
            } catch (error) {
              record.status = "failed"; record.error = `Cannot persist final Agent state; output remains at ${record.outputPath ?? record.launch?.sessionFile ?? "the in-memory result"}. Fix checkpoint storage before retrying. ${String(error)}`;
              this.diagnostics.push({ id: record.id, message: record.error });
              try { this.persist(); } catch (repair) { this.diagnostics.push({ id: record.id, message: `Final checkpoint repair uncertain: ${String(repair)}` }); }
            }
            try { this.onComplete?.(record); } catch (error) { this.diagnostics.push({ id: record.id, message: `Completion callback failed: ${String(error)}` }); }
          }
        }
      }
    })();
    return record.promise;
  }

  private resumeEvidence(record: SessionAgentRecord): void {
    if (record.recoveryDiagnostic) throw new Error(record.recoveryDiagnostic);
    const dir = path.join(this.sessionRoot, record.id);
    const file = record.launch?.sessionFile;
    if (!file || record.launch?.sessionDir !== dir || !this.inside(file, dir) || this.canonical(dir) !== dir || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error("Missing or unsafe original child session file; restore the original file, or start a new Agent.");
    // Runtime validates the JSONL header again immediately before opening.
    const selected = discoverAgents(this.cwd, { includeProject: this.projectTrusted, projectRoot: this.cwd }).find((agent) => agent.name === record.agent.name && this.canonical(agent.filePath) === this.canonical(record.agent.filePath));
    if (!selected) throw new Error("Agent source is no longer trusted/enabled. Use mesh list_agents and resolve discovery diagnostics.");
    this.validateResources(selected); record.agent = selected;
  }

  async resume(id: string, prompt: string, options: { userAuthorized?: boolean; foreground?: boolean; onQueued?: () => void } = {}): Promise<SessionAgentRecord> {
    if (!prompt.trim()) throw new Error("Resume requires a nonblank prompt.");
    if (!id.trim()) throw new Error("Agent resume requires a nonblank ID.");
    if (this.closed) throw new Error("Agent manager is shut down.");
    const record = this.records.get(id);
    if (!record || ["running", "queued"].includes(record.status) || this.continuations.has(id)) throw new Error(`Agent is not resumable: ${id}; wait for completion or use steer_subagent.`);
    if (record.worktree) throw new Error(`Worktree Agent is not resumable: ${id}; manually accept the handoff.`);
    if (!(record.launch?.persistent ?? record.agent.persistSession ?? false)) throw new Error(`Agent session was not persisted: ${id}; start a new Agent.`);
    if (record.autoContinueBlocked && !options.userAuthorized) throw new Error(`Automatic continuation blocked after ${record.abortSource ?? "user/unknown"} cancellation. User must authorize with /agents resume ${id} <instruction>.`);
    const abortVersion = record.abortVersion ?? 0;
    this.continuations.add(id);
    try {
      await record.promise;
      if (this.closed) throw new Error("Agent manager is shut down.");
      if ((record.abortVersion ?? 0) !== abortVersion || (record.autoContinueBlocked && !options.userAuthorized)) throw new Error("Automatic continuation blocked by a new cancellation while draining; user must authorize again.");
      this.resumeEvidence(record);
      if (options.userAuthorized) { record.autoContinueBlocked = false; record.stoppedByUser = false; }
      record.foreground = options.foreground ?? false;
      const completion = this.runRecord(record, prompt, true);
      options.onQueued?.();
      await completion;
      return record;
    } finally { this.continuations.delete(id); }
  }

  async send(id: string, message: string, expectedGeneration?: number, messageId?: string): Promise<{ id: string; generation: number; disposition: string; duplicate?: boolean; completed: false; source: "host" }> {
    if (!this.settings.directCommunication) throw new Error("send_subagent is disabled; explicitly enable directCommunication in Host mesh settings.");
    if (this.closed) throw new Error("Agent manager is shut down.");
    if (!message.trim() || Buffer.byteLength(message) > 32768 || (messageId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(messageId))) throw new Error("Invalid direction: nonblank message <=32KiB and optional message_id <=128 safe characters required.");
    const record = this.records.get(id); if (!record) throw new Error(`Unknown Agent ID: ${id}; use get_subagent_result or /agents.`);
    const generation = record.generation ?? 0;
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== generation)) throw new Error(`Stale generation; current generation is ${generation}. Recheck the target.`);
    const key = messageId ?? crypto.createHash("sha256").update(message).digest("hex");
    const prior = record.receipts?.find((receipt) => receipt.key === key && receipt.generation === generation);
    if (prior) return { id, generation, disposition: prior.disposition, duplicate: true, completed: false, source: "host" };
    if (record.autoContinueBlocked) throw new Error(`Automatic continuation blocked; user must use /agents resume ${id} <instruction>.`);
    const receiptSlots = ["queued", "running"].includes(record.status) || record.settling ? 1 : 2;
    if ((record.receipts?.length ?? 0) + receiptSlots > 128) throw new Error("Direction receipt limit reached (128 per Agent); use explicit resume or a new Agent.");
    if (record.settling) {
      const count = this.waitingDirections.get(id) ?? 0;
      if (count >= 16) throw new Error("Direction queue full (16 waiting for close); wait and recheck.");
      this.waitingDirections.set(id, count + 1);
      try { await record.promise; return await this.send(id, message, expectedGeneration, messageId); }
      finally { const remaining = (this.waitingDirections.get(id) ?? 1) - 1; if (remaining) this.waitingDirections.set(id, remaining); else this.waitingDirections.delete(id); }
    }
    let disposition: string;
    if (record.status === "queued" || (record.status === "running" && !record.ready)) {
      if ((record.directions?.length ?? 0) >= 16) throw new Error("Direction queue full (16); wait for this Agent.");
      (record.directions ??= []).push({ generation, message: `[Host direction; source=host]\n${message}` }); disposition = "queued";
    } else if (record.status === "running") {
      if (!record.execution) throw new Error(`Agent is not running: ${id}`);
      // The caller payload was checked above; trusted framing is not its budget.
      record.execution.steer(`[Host direction; source=host]\n${message}`); disposition = "steered";
    }
    else {
      if (this.continuations.has(id)) throw new Error("Continuation already requested; wait and recheck generation.");
      if (record.worktree || !(record.launch?.persistent ?? record.agent.persistSession)) throw new Error(this.nextAction(record));
      this.resumeEvidence(record);
      disposition = "continuation_requested";
      // Reserve the receipt before draining so a replay in the same tick cannot
      // request another continuation. Keep receipts for both sides of the transition.
      const reservation = { key, generation, disposition };
      (record.receipts ??= []).push(reservation);
      try {
        await new Promise<void>((resolve, reject) => {
          void this.resume(id, `[Host direction; source=host]\n${message}`, { onQueued: resolve }).catch(reject);
        });
      } catch (error) { record.receipts = record.receipts?.filter((receipt) => receipt !== reservation); throw error; }
    }
    (record.receipts ??= []).push({ key, generation: disposition === "continuation_requested" ? generation + 1 : generation, disposition });
    this.persist();
    return { id, generation: disposition === "continuation_requested" ? generation + 1 : generation, disposition, completed: false, source: "host" };
  }

  /** No ready queue, terminal continuation, persistence mutation, or cancel unlock. */
  bridgeHint(id: string, generation: number, message: string): boolean {
    const record = this.records.get(id);
    if (this.closed || !this.projectTrusted || record?.generation !== generation || record.status !== "running" || !record.ready || record.settling || record.autoContinueBlocked || !record.execution || this.controllers.get(id)?.signal.aborted) return false;
    return record.execution.steerActive?.(message) ?? false;
  }

  steer(id: string, message: string): void {
    const record = this.records.get(id);
    if (!record?.execution || record.status !== "running") throw new Error(`Agent is not running: ${id}`);
    if (!message.trim() || Buffer.byteLength(message) > 32768) throw new Error("Steering message must be nonblank and <=32KiB.");
    if (!record.ready) {
      if ((record.directions?.length ?? 0) >= 16) throw new Error("Direction queue full (16); wait for readiness.");
      (record.directions ??= []).push({ generation: record.generation!, message });
    } else record.execution.steer(message);
  }

  conversation(id: string): string {
    const record = this.records.get(id);
    if (record?.execution) return record.execution.conversation();
    if (record?.launch?.transcriptPath && !record.recoveryDiagnostic) try { return readBoundedFile(record.launch.transcriptPath); } catch {}
    return "";
  }

  abort(id: string, source: "user" | "unknown" | "shutdown" | "timeout" = "unknown"): boolean {
    const record = this.records.get(id);
    if (!record || (!["queued", "running"].includes(record.status) && !record.settling && !this.continuations.has(id))) return false;
    if (!record.abortSource || source === "user" || source === "unknown") record.abortSource = source;
    if (source === "user" || source === "unknown") { record.abortVersion = (record.abortVersion ?? 0) + 1; record.autoContinueBlocked = true; record.stoppedByUser ||= source === "user"; }
    this.controllers.get(id)?.abort();
    record.execution?.abort(source === "timeout" ? "timeout" : "cancelled");
    record.status = "stopped"; record.settling = true; this.persist(); return true;
  }

  private restore(): void {
    const file = this.registryFile;
    const data = readJson<Array<Omit<SessionAgentRecord, "execution" | "promise">>>(file) ?? [];
    if (!Array.isArray(data) || data.length > 1024) throw new Error(`Invalid subagent registry ${file}: expected at most 1024 records`);
    for (const stored of data) {
      if (!stored || typeof stored !== "object" || typeof stored.id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(stored.id) || this.records.has(stored.id) || typeof stored.cwd !== "string" || !["queued", "running", "completed", "failed", "stopped"].includes(stored.status)) throw new Error(`Invalid subagent registry ${file}: malformed record`);
      const agent = stored.agent;
      if (!agent || typeof agent !== "object" || typeof agent.name !== "string" || typeof agent.description !== "string" || typeof agent.systemPrompt !== "string" || !["bundled", "user", "project"].includes(agent.source) || typeof agent.filePath !== "string") throw new Error(`Invalid subagent registry ${file}: malformed agent`);
      for (const [label, values] of [["tools", agent.tools], ["disallowedTools", agent.disallowedTools], ["extensions", agent.extensions], ["skills", agent.skills]] as const) if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string"))) throw new Error(`Invalid subagent registry ${file}: malformed agent ${label}`);
      if (agent.extensions?.some((value) => value === "*" || path.isAbsolute(value) || value.includes("/") || value.includes("\\") || !this.settings.childExtensions[value]) || agent.skills?.some((value) => value === "*" || path.isAbsolute(value) || value.includes("/") || value.includes("\\") || !this.settings.childSkills[value])) throw new Error(`Invalid subagent registry ${file}: unsafe agent resources`);
      let canonicalAgentFile: string; try { canonicalAgentFile = fs.realpathSync(agent.filePath); } catch { throw new Error(`Invalid subagent registry ${file}: invalid agent file`); }
      const allowedAgentRoots = agent.source === "project" ? [path.join(this.cwd, CONFIG_DIR_NAME, "agents")] : agent.source === "user" ? [path.join(getAgentDir(), "agents")] : [BUNDLED_AGENTS_DIR];
      if (!allowedAgentRoots.some((root) => { try { return this.inside(canonicalAgentFile, root); } catch { return false; } })) throw new Error(`Invalid subagent registry ${file}: agent file escapes source root`);
      const canonicalCwd = fs.realpathSync(path.resolve(stored.cwd));
      if (canonicalCwd !== this.cwd) throw new Error(`Invalid subagent registry ${file}: record cwd escapes project root`);
      const launch = stored.launch;
      if (launch !== undefined && (!launch || typeof launch !== "object" || (launch.transcriptPath !== undefined && typeof launch.transcriptPath !== "string") || (launch.sessionDir !== undefined && typeof launch.sessionDir !== "string") || (launch.sessionFile !== undefined && typeof launch.sessionFile !== "string"))) throw new Error(`Invalid subagent registry ${file}: malformed launch`);
      if (launch?.transcriptPath && (!this.inside(launch.transcriptPath, path.join(this.cwd, CONFIG_DIR_NAME, "mesh", "transcripts")) || path.extname(launch.transcriptPath) !== ".jsonl")) throw new Error(`Invalid subagent registry ${file}: unsafe transcript path`);
      let recoveryDiagnostic: string | undefined;
      const expectedDir = path.join(this.sessionRoot, stored.id);
      if ((launch?.sessionDir && (launch.sessionDir !== expectedDir || this.canonical(expectedDir) !== expectedDir)) || (launch?.sessionFile && (path.extname(launch.sessionFile) !== ".jsonl" || !this.inside(launch.sessionFile, expectedDir)))) {
        recoveryDiagnostic = "Unsafe or unprovable legacy child session directory/file. Original reference retained; no Host files were read or migrated. Start a new Agent, or restore proven original Direct evidence.";
        this.diagnostics.push({ id: stored.id, message: recoveryDiagnostic });
      }
      const record: SessionAgentRecord = { ...stored, execution: undefined, promise: undefined, ready: false, settling: false, recoveryDiagnostic, agent: { ...agent, filePath: canonicalAgentFile } };
      if (record.status === "running" || record.status === "queued") { record.status = "stopped"; record.autoContinueBlocked = true; record.error = "Host restarted; resume the persisted child session"; record.completedAt = Date.now(); }
      record.cumulativeUsage ??= record.result?.usage;
      // Persistent sessions reconnect lazily on resume; restoring records must not eagerly create AgentSessions.
      this.records.set(record.id, record);
    }
  }

  private persist(): void {
    const file = this.registryFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const data = this.list().map(({ execution: _execution, promise: _promise, ...record }) => record);
    atomicWriteCheckpoint(file, data);
  }

  /** Resolution means admitted records finished completion/close, not that every
   * checkpoint succeeded. Cancellation errors remain in diagnostics (with cause)
   * independently of final record state. A rejected drain must not release owners. */
  shutdown(): Promise<void> {
    this.closed = true;
    return this.shutdownPromise ??= (async () => {
      for (const record of this.records.values()) {
        try { this.abort(record.id, "shutdown"); }
        catch (cause) { this.diagnostics.push({ id: record.id, message: `Shutdown cancellation failed; still waiting for execution close: ${String(cause)}`, cause }); }
      }
      const drained = await Promise.allSettled(this.list().map((record) => record.promise));
      const failures = drained.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Agent shutdown drain failed; retain Fleet ownership and inspect diagnostics");
    })();
  }
}
