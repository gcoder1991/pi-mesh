import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";
import type { ChildResult } from "./pi-process.ts";
import { SubagentRuntime, type SubagentExecution, type SubagentSession } from "./subagent-runtime.ts";
import type { MeshSettings } from "./settings.ts";
import { atomicWrite, putAgentOutput, readJson } from "./store.ts";
import { createNodeWorktree, finalizeNodeWorktree, prepareWorktreeRun, type WorktreeState } from "./worktree.ts";

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
  launch?: { model?: string; thinking?: string; maxTurns?: number; persistent?: boolean; transcript?: boolean; transcriptPath?: string; parentContext?: string; sessionDir?: string };
  activity?: { turns: number; toolUses: number; responseText: string; activeTools: string[]; usage: ChildResult["usage"] };
  generation?: number;
}

const MAX_STORED_OUTPUT_BYTES = 200 * 1024;

export class SessionAgentManager {
  private readonly records = new Map<string, SessionAgentRecord>();
  private readonly runtime: SubagentRuntime;
  private readonly cwd: string;
  private readonly registryFile: string;
  private readonly maxConcurrent: number;
  private readonly queued: SessionAgentRecord[] = [];
  private running = 0;
  private onComplete?: (record: SessionAgentRecord) => void;
  private onStart?: (record: SessionAgentRecord) => void;

  constructor(settings: MeshSettings, cwd: string, onComplete?: (record: SessionAgentRecord) => void, sessionId = "default") {
    this.runtime = new SubagentRuntime(settings);
    this.cwd = fs.realpathSync(path.resolve(cwd));
    const safeSessionId = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    this.registryFile = path.join(this.cwd, CONFIG_DIR_NAME, "mesh", "subagents", `${safeSessionId}.json`);
    this.maxConcurrent = settings.maxConcurrentAgents;
    this.onComplete = onComplete;
    this.restore();
  }

  setOnComplete(value: (record: SessionAgentRecord) => void): void { this.onComplete = value; }
  setOnStart(value: (record: SessionAgentRecord) => void): void { this.onStart = value; }
  list(): SessionAgentRecord[] { return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt); }
  private captureResult(record: SessionAgentRecord, result: ChildResult): void {
    record.result = result;
    const bytes = Buffer.byteLength(result.output, "utf8");
    record.outputBytes = bytes;
    if (bytes <= MAX_STORED_OUTPUT_BYTES) return;
    record.outputPath = putAgentOutput(this.cwd, record.id, result.output);
    record.outputTruncated = true;
    record.result = { ...result, output: `${Buffer.from(result.output).subarray(0, MAX_STORED_OUTPUT_BYTES).toString("utf8")}\n[truncated; full output: ${record.outputPath}]` };
  }
  private transcriptPath(id: string, transcript?: boolean): string | undefined {
    return transcript === false ? undefined : path.join(this.cwd, CONFIG_DIR_NAME, "mesh", "transcripts", `${id}.jsonl`);
  }
  get(id: string): SessionAgentRecord | undefined { return this.records.get(id); }

  spawn(agent: AgentDefinition, prompt: string, description: string, cwd: string, options: { model?: string; thinking?: string; maxTurns?: number; persistent?: boolean; transcript?: boolean; parentContext?: string; worktree?: boolean; sessionDir?: string }): SessionAgentRecord {
    const id = crypto.randomUUID();
    let worktree: WorktreeState | undefined;
    if (options.worktree) worktree = createNodeWorktree(prepareWorktreeRun(cwd, [cwd]), "agent", id, 1, cwd);
    const transcriptPath = this.transcriptPath(id, options.transcript ?? agent.outputTranscript);
    const record: SessionAgentRecord = { id, agent, description, prompt, cwd, status: "running", createdAt: Date.now(), worktree, launch: { model: options.model, thinking: options.thinking, maxTurns: options.maxTurns, persistent: options.persistent, transcript: options.transcript, transcriptPath, parentContext: options.parentContext, sessionDir: options.sessionDir }, activity: { turns: 0, toolUses: 0, responseText: "", activeTools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } } };
    this.records.set(id, record);
    record.generation = 1;
    const start = () => {
      this.running++;
      const generation = record.generation!;
      const execution = this.runtime.start(agent, { id, cwd: worktree?.cwd ?? cwd, prompt, model: options.model, thinking: options.thinking, maxTurns: options.maxTurns, persistent: options.persistent, transcript: options.transcript, transcriptPath, parentContext: options.parentContext, sessionDir: options.sessionDir, onEvent: (event) => this.trackActivity(record, event) });
      record.execution = execution;
      this.onStart?.(record);
      record.promise = execution.completion.then((result) => {
        this.captureResult(record, result);
        if (record.generation !== generation || record.status === "stopped") return;
        record.status = result.error ? "failed" : "completed";
        if (record.worktree) record.worktree = finalizeNodeWorktree(cwd, "agent", id, record.worktree, record.status, result.output);
        record.completedAt = Date.now();
        this.persist();
        this.onComplete?.(record);
      }).finally(() => {
        if ((record.launch?.persistent ?? record.agent.persistSession ?? false) && !record.worktree) {
          const settled = record.execution; record.execution = undefined; void settled?.close();
        }
        this.running--; this.startNext();
      });
    };
    if (this.running < this.maxConcurrent) start(); else { record.status = "queued"; this.queued.push(record); }
    this.persist();
    return record;
  }

  async resume(id: string, prompt: string): Promise<SessionAgentRecord> {
    const record = this.records.get(id);
    if (!record || record.status === "running" || record.status === "queued") throw new Error(`Agent is not resumable: ${id}`);
    if (record.worktree) throw new Error(`Worktree Agent is not resumable: ${id}`);
    const persistent = record.launch?.persistent ?? record.agent.persistSession ?? false;
    if (!persistent) throw new Error(`Agent session was not persisted: ${id}`);
    if (this.running >= this.maxConcurrent) throw new Error(`Agent concurrency limit reached (${this.maxConcurrent})`);
    if (!record.execution) record.execution = this.runtime.connect(record.agent, { id: record.id, cwd: record.cwd, prompt: record.prompt, model: record.launch?.model, thinking: record.launch?.thinking, maxTurns: record.launch?.maxTurns, persistent: true, transcript: record.launch?.transcript, transcriptPath: record.launch?.transcriptPath, parentContext: record.launch?.parentContext, sessionDir: record.launch?.sessionDir });
    record.status = "running"; record.error = undefined; record.completedAt = undefined; record.generation = (record.generation ?? 0) + 1; const generation = record.generation; this.running++; this.onStart?.(record);
    record.promise = record.execution.session.prompt(prompt).then((result) => {
      this.captureResult(record, result);
      if (record.generation !== generation || record.status === "stopped") return;
      record.status = result.error ? "failed" : "completed"; record.completedAt = Date.now(); this.persist(); this.onComplete?.(record);
    }).finally(() => { const settled = record.execution; record.execution = undefined; void settled?.close(); this.running--; this.startNext(); });
    await record.promise;
    return record;
  }

  private startNext(): void {
    const record = this.queued.shift(); if (!record) return;
    record.status = "running"; record.error = undefined; record.generation = (record.generation ?? 0) + 1; const generation = record.generation;
    let execution: SubagentExecution;
    try { execution = this.runtime.start(record.agent, { id: record.id, cwd: record.worktree?.cwd ?? record.cwd, prompt: record.prompt, ...record.launch, onEvent: (event) => this.trackActivity(record, event) }); }
    catch (error) { record.status = "failed"; record.error = error instanceof Error ? error.message : String(error); record.completedAt = Date.now(); this.persist(); this.onComplete?.(record); return void this.startNext(); }
    record.execution = execution; this.running++; this.onStart?.(record);
    record.promise = execution.completion.then((result) => {
      this.captureResult(record, result);
      if (record.generation !== generation || record.status === "stopped") return;
      record.status = result.error ? "failed" : "completed"; record.completedAt = Date.now(); this.persist(); this.onComplete?.(record);
    }).finally(() => {
      if ((record.launch?.persistent ?? record.agent.persistSession ?? false) && !record.worktree) {
        const settled = record.execution; record.execution = undefined; void settled?.close();
      }
      this.running--; this.startNext();
    });
    this.persist();
  }

  private trackActivity(record: SessionAgentRecord, event: any): void {
    const activity = record.activity ??= { turns: 0, toolUses: 0, responseText: "", activeTools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
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

  steer(id: string, message: string): void {
    const record = this.records.get(id);
    if (!record?.execution || record.status !== "running") throw new Error(`Agent is not running: ${id}`);
    record.execution.steer(message);
  }

  conversation(id: string): string {
    const record = this.records.get(id);
    if (record?.execution) return record.execution.conversation();
    if (record?.launch?.transcriptPath) try { return fs.readFileSync(record.launch.transcriptPath, "utf8"); } catch {}
    return "";
  }

  abort(id: string): boolean {
    const record = this.records.get(id);
    if (!record || !["queued", "running"].includes(record.status)) return false;
    record.generation = (record.generation ?? 0) + 1;
    if (record.status === "queued") this.queued.splice(this.queued.indexOf(record), 1);
    else record.execution?.abort();
    record.status = "stopped"; record.completedAt = Date.now(); this.persist(); this.onComplete?.(record); return true;
  }

  private restore(): void {
    const file = this.registryFile;
    const data = readJson<Array<Omit<SessionAgentRecord, "execution" | "promise">>>(file) ?? [];
    if (!Array.isArray(data) || data.length > 1024) throw new Error(`Invalid subagent registry ${file}: expected at most 1024 records`);
    for (const stored of data) {
      if (!stored || typeof stored !== "object" || typeof stored.id !== "string" || typeof stored.cwd !== "string" || !["queued", "running", "completed", "failed", "stopped"].includes(stored.status)) throw new Error(`Invalid subagent registry ${file}: malformed record`);
      const canonicalCwd = fs.realpathSync(path.resolve(stored.cwd));
      if (canonicalCwd !== this.cwd) throw new Error(`Invalid subagent registry ${file}: record cwd escapes project root`);
      const record: SessionAgentRecord = { ...stored };
      if (record.status === "running" || record.status === "queued") { record.status = "stopped"; record.error = "Host restarted; resume the persisted child session"; record.completedAt = Date.now(); }
      // Persistent sessions reconnect lazily on resume; restoring hundreds of records must not spawn hundreds of Pi processes.
      this.records.set(record.id, record);
    }
  }

  private persist(): void {
    const file = this.registryFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const data = this.list().slice(0, 1024).map(({ execution: _execution, promise: _promise, ...record }) => record);
    atomicWrite(file, data);
  }

  async shutdown(): Promise<void> {
    for (const record of this.records.values()) if (record.status === "running" || record.status === "queued") this.abort(record.id);
    await Promise.allSettled(this.list().map((record) => record.execution?.close()).filter(Boolean) as Promise<void>[]);
  }
}
