import * as fs from "node:fs";
import * as path from "node:path";
import { validateRunState, CHECKPOINT_MAX_BYTES } from "./recovery-state.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface ControlMessage {
  id: string;
  runId: string;
  from: string;
  to: string;
  content: string;
  replyTo?: string;
  createdAt: number;
  senderAttempt?: number;
  source?: "host" | "child";
  displayFrom?: string;
  ackedAt?: number;
  /** Authenticated relay Host provenance, never child/user authorization. */
  bridge?: { inboxId: string; sourceSessionId: string; sourceInstanceId: string; origin: string; correlationId: string; expiresAt: number; hops: number; budget: number; routeId: string; claim: "host-transcribed-not-user" };
}

export interface GrowthProposal<T = unknown> {
  id: string;
  runId: string;
  requester: string;
  reason: string;
  tasks: T;
  status: "proposed" | "denied" | "committed";
  baseRevision: number;
  requesterAttempt: number;
  createdAt: number;
  decidedAt?: number;
  committedNodeIds?: string[];
  error?: string;
}

export function meshDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "mesh");
}

export type WriteOutcome = "not-stored" | "stored-visible" | "unknown";

/** Visibility is not durability. The original I/O error is always propagated. */
export class AtomicWriteError extends Error {
  readonly file: string;
  readonly renamed: boolean;
  readonly outcome: WriteOutcome;
  compensationError?: unknown;
  compensated?: boolean;
  constructor(file: string, renamed: boolean, outcome: WriteOutcome, cause: unknown) {
    super(`Atomic write ${file} (${outcome}; durability unconfirmed): ${String(cause)}`, { cause });
    this.file = file; this.renamed = renamed; this.outcome = outcome;
  }
}

function sameContent(file: string, content: string | Buffer): boolean {
  return fs.readFileSync(file).equals(Buffer.isBuffer(content) ? content : Buffer.from(content));
}

function visibleOutcome(file: string, content: string | Buffer, renamed: boolean): WriteOutcome {
  try { return sameContent(file, content) ? "stored-visible" : renamed ? "unknown" : "not-stored"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" && !renamed ? "not-stored" : "unknown"; }
}

function withHandle(handle: number, action: () => void): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  try { fs.closeSync(handle); } catch (error) {
    failure = failure ? new AggregateError([failure, error], `${String(failure)}; close also failed: ${String(error)}`) : error;
  }
  if (failure) throw failure;
}

export function atomicWriteContent(file: string, content: string | Buffer): void {
  const dir = path.dirname(file);
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let renamed = false, failure: unknown;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const handle = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    withHandle(handle, () => { fs.writeFileSync(handle, content); fs.fsyncSync(handle); });
    fs.renameSync(temp, file); renamed = true;
    const directory = fs.openSync(dir, "r");
    withHandle(directory, () => fs.fsyncSync(directory));
  } catch (error) { failure = error; }
  try { fs.rmSync(temp, { force: true }); } catch (error) { failure = failure ? new AggregateError([failure, error], `${String(failure)}; temp cleanup also failed: ${String(error)}`) : error; }
  if (failure) throw new AtomicWriteError(file, renamed, visibleOutcome(file, content, renamed), failure);
}

export function atomicWrite(file: string, value: unknown): void {
  atomicWriteContent(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Checkpoint-only compensation, synchronous and exact-payload/owner fenced.
 * Not a multi-file transaction: a permanently unwritable disk can defeat repair.
 * Mailbox callers must NOT use this: a visible delivery may already be consumed.
 */
export function atomicWriteCheckpoint(file: string, value: unknown, isOwner: () => boolean = () => true): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let previous: Buffer | undefined;
  try { previous = fs.readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { atomicWriteContent(file, content); }
  catch (error) {
    if (error instanceof AtomicWriteError && error.outcome === "stored-visible") {
      try {
        if (!isOwner() || !sameContent(file, content)) throw new Error("Compensation refused: owner/payload changed; recover explicitly");
        if (previous) atomicWriteContent(file, previous);
        else {
          fs.unlinkSync(file);
          const directory = fs.openSync(path.dirname(file), "r");
          withHandle(directory, () => fs.fsyncSync(directory));
        }
        error.compensated = true; error.message += "; previous checkpoint restored";
      } catch (repair) { error.compensationError = repair; error.message += `; compensation uncertain: ${String(repair)}`; }
    }
    throw error;
  }
}

export function readJson<T>(file: string): T | undefined {
  let content: string;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Preserve native read identity/code/cause; unreadable is not missing or bad JSON.
    throw error;
  }
  try { return JSON.parse(content) as T; }
  catch (error) {
    throw new Error(`Invalid JSON state ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function runFile(cwd: string, runId: string): string {
  return path.join(meshDir(cwd), "runs", `${runId}.json`);
}

export function attemptDir(cwd: string, runId: string, nodeId: string, attempt: number): string {
  return path.join(meshDir(cwd), "artifacts", runId, nodeId, `attempt-${attempt}`);
}

export function attemptResultFile(cwd: string, runId: string, nodeId: string, attempt: number): string {
  return path.join(attemptDir(cwd, runId, nodeId, attempt), "attempt-result.json");
}

export function putNodeOutput(cwd: string, runId: string, nodeId: string, attempt: number, output: string): string {
  const file = path.join(attemptDir(cwd, runId, nodeId, attempt), "output.md");
  atomicWriteContent(file, output);
  return file;
}

export function putAgentOutput(cwd: string, agentId: string, output: string): string {
  const file = path.join(meshDir(cwd), "artifacts", "agents", agentId, "output.md");
  atomicWriteContent(file, output);
  return file;
}

export function putAttemptResult(cwd: string, runId: string, nodeId: string, attempt: number, result: unknown): string {
  const file = attemptResultFile(cwd, runId, nodeId, attempt);
  atomicWrite(file, result);
  return file;
}

export function putDiagnosticExplanation(cwd: string, runId: string, nodeId: string, attempt: number, content: string): string {
  const file = path.join(attemptDir(cwd, runId, nodeId, attempt), "diagnostic.md");
  atomicWriteContent(file, content);
  return file;
}

export function appendDebugEvent(cwd: string, event: unknown, maxBytes = 4 * 1024 * 1024): string {
  const file = path.join(meshDir(cwd), "debug.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return file;
}

export function pruneMeshState(cwd: string, options: { retentionDays: number; maxTerminalRuns: number }): { removedRuns: number } {
  const cutoff = Date.now() - options.retentionDays * 86_400_000;
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  const runs = listRunFiles(cwd).map((file) => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CHECKPOINT_MAX_BYTES) return { file, run: undefined };
      const run: unknown = readJson(file); validateRunState(run);
      if (path.basename(file) !== `${run.id}.json`) return { file, run: undefined };
      return { file, run };
    } catch { return { file, run: undefined }; } // recover emits per-record diagnostics; retain bad evidence
  })
    .filter((entry): entry is { file: string; run: import("./manager.ts").MeshRun } => Boolean(entry.run && terminal.has(entry.run.status)))
    .sort((a, b) => (b.run.finishedAt ?? b.run.updatedAt ?? 0) - (a.run.finishedAt ?? a.run.updatedAt ?? 0));
  const remove = runs.filter((entry, index) => index >= options.maxTerminalRuns || (entry.run.finishedAt ?? entry.run.updatedAt ?? 0) < cutoff);
  for (const { file, run } of remove) {
    fs.rmSync(file, { force: true });
    for (const dir of ["artifacts", "messages", "growth", "leases"]) fs.rmSync(path.join(meshDir(cwd), dir, run.id), { recursive: true, force: true });
  }
  return { removedRuns: remove.length };
}

export function listRunFiles(cwd: string): string[] {
  try {
    return fs.readdirSync(path.join(meshDir(cwd), "runs"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(meshDir(cwd), "runs", name));
  } catch {
    return [];
  }
}

function spoolDir(cwd: string, kind: "messages" | "growth", runId: string): string {
  return path.join(meshDir(cwd), kind, runId);
}

export function putMessage(cwd: string, message: ControlMessage, limits?: { payloadMaxBytes: number; recipientUnreadMaxBytes: number; ifAbsent?: boolean; /** Synchronous admission under the recipient lock, after duplicate detection. Must not write/reenter this spool. */ admit?: (rows: ControlMessage[]) => void }): { outcome: "stored" | "stored-visible"; durabilityWarning?: string; duplicate?: boolean } {
  const payloadBytes = Buffer.byteLength(message.content, "utf8");
  if (limits && payloadBytes > limits.payloadMaxBytes) throw new Error(`Message payload exceeds ${limits.payloadMaxBytes} bytes`);
  const dir = spoolDir(cwd, "messages", message.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, `.recipient-${Buffer.from(message.to).toString("hex")}.lock`);
  const openLock = (): number => {
    try { return fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Age cannot prove that a paused writer is dead. Unknown/stale locks fail
      // closed; never let another writer pass its ifAbsent/quota checks.
      throw new Error(`Recipient ${message.to} mailbox is busy (${lock}). Do not remove by age: stop all spool writers, inspect retained evidence, then explicitly repair the orphan lock before restarting.`);
    }
  };
  let handle: number | undefined;
  const file = path.join(dir, `${message.id}.json`);
  let failure: unknown, duplicate = false, attemptedWrite = false, written = false;
  try {
    if (limits) {
      handle = openLock();
      // Same recipient lock serializes first-write tombstones across Hosts.
      if (limits.ifAbsent) { try { fs.lstatSync(file); duplicate = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      if (!duplicate) {
        const rows = messages(cwd, message.runId);
        const unreadBytes = rows.filter((item) => item.to === message.to && !item.ackedAt)
          .reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
        if (unreadBytes + payloadBytes > limits.recipientUnreadMaxBytes) throw new Error(`Recipient ${message.to} unread mailbox exceeds ${limits.recipientUnreadMaxBytes} bytes`);
        limits.admit?.(rows);
      }
    }
    if (!duplicate) { attemptedWrite = true; atomicWrite(file, message); written = true; }
  } catch (error) { failure = error; }
  try { if (handle !== undefined) {
    try {
      const held = fs.fstatSync(handle), current = fs.lstatSync(lock);
      if (current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino) throw new Error(`Recipient lock identity changed: ${lock}; retained for explicit repair`);
      fs.unlinkSync(lock);
    } finally { fs.closeSync(handle); }
  } }
  catch (error) { failure ??= error; }
  // Cleanup cannot undo a confirmed duplicate or a completed rename. In
  // particular, a concurrent legitimate ACK changes the bytes, not that fact.
  if (failure && duplicate) return { outcome: "stored-visible", duplicate: true, durabilityWarning: `Existing ID retained; original durability is not reasserted; ${String(failure)}` };
  if (failure) {
    const renamed = written || (failure instanceof AtomicWriteError && failure.renamed);
    const outcome = attemptedWrite ? visibleOutcome(file, `${JSON.stringify(message, null, 2)}\n`, renamed) : "not-stored";
    if (outcome === "stored-visible") return { outcome, durabilityWarning: String(failure) };
    throw new AtomicWriteError(file, renamed, outcome, failure);
  }
  return duplicate ? { outcome: "stored-visible", duplicate: true, durabilityWarning: "Existing ID retained; original durability is not reasserted" } : { outcome: "stored" };
}

export function messages(cwd: string, runId: string): ControlMessage[] {
  const dir = spoolDir(cwd, "messages", runId);
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json"))
    .map((name) => readJson<ControlMessage>(path.join(dir, name)))
    .filter((item): item is ControlMessage => Boolean(item))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function ackMessage(cwd: string, runId: string, messageId: string, recipient: string): boolean {
  const file = path.join(spoolDir(cwd, "messages", runId), `${messageId}.json`);
  const claim = `${file}.${recipient}.ack`;
  let handle: number;
  try { handle = fs.openSync(claim, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - fs.statSync(claim).mtimeMs < 60_000) return false;
      fs.rmSync(claim, { force: true });
      handle = fs.openSync(claim, "wx", 0o600);
    } catch { return false; }
  }
  try {
    const message = readJson<ControlMessage>(file);
    if (!message || message.to !== recipient || message.ackedAt) return false;
    message.ackedAt = Date.now();
    atomicWrite(file, message);
    return true;
  } finally { fs.closeSync(handle); fs.rmSync(claim, { force: true }); }
}

export function putGrowth<T>(cwd: string, proposal: GrowthProposal<T>): void {
  atomicWrite(path.join(spoolDir(cwd, "growth", proposal.runId), `${proposal.id}.json`), proposal);
}

export function growthProposals<T>(cwd: string, runId: string): GrowthProposal<T>[] {
  const dir = spoolDir(cwd, "growth", runId);
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json"))
    .map((name) => readJson<GrowthProposal<T>>(path.join(dir, name)))
    .filter((item): item is GrowthProposal<T> => Boolean(item))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Honest per-recipient receipts: stored deliveries are never rolled back/retried. */
export async function storeMessages(cwd: string, deliveries: ControlMessage[], limits: { payloadMaxBytes: number; recipientUnreadMaxBytes: number }, onMessageStored?: (message: ControlMessage) => void | Promise<void>) {
  const receipts: Array<{ to: string; id: string; stored: boolean; outcome: "stored" | WriteOutcome; durabilityWarning?: string; error?: string; notificationError?: string }> = [];
  for (const message of deliveries) {
    const receipt: typeof receipts[number] = { to: message.to, id: message.id, stored: false, outcome: "not-stored" };
    receipts.push(receipt);
    try { Object.assign(receipt, putMessage(cwd, message, limits)); receipt.stored = true; }
    catch (error) { receipt.outcome = error instanceof AtomicWriteError ? error.outcome : "not-stored"; receipt.error = String(error); continue; }
    try { await onMessageStored?.(message); } catch (error) { receipt.notificationError = String(error); }
  }
  const stored = receipts.filter((receipt) => receipt.stored).length;
  return { receipts, stored, partial: stored > 0 && stored < receipts.length, messages: deliveries.filter((_, index) => receipts[index]!.stored) };
}

/** Tool receipts never echo message bodies. With <=128 recipients, 64-character
 * node IDs and generated UUIDs, core receipts (including warning flags) occupy
 * <48KiB even when every write/callback supplies an arbitrarily large error.
 * Outcomes, not the absence of a warning preview, decide safe retry. */
export function messageReceiptDetails(result: Awaited<ReturnType<typeof storeMessages>>) {
  const { messages: _bodies, ...details } = result;
  if (Buffer.byteLength(JSON.stringify(details)) <= 48 * 1024) return details;
  return { ...details, warningsTruncated: true, receipts: details.receipts.map(({ to, id, stored, outcome, durabilityWarning, error, notificationError }) => ({
    to, id, stored, outcome, ...(durabilityWarning ? { durabilityWarning: "Durability unconfirmed" } : {}),
    ...(error ? { error: outcome === "unknown" ? "Inspect existing ID before resending" : "Storage rejected" } : {}),
    ...(notificationError ? { notificationError: "Notification failed; storage outcome unchanged" } : {}),
  })) };
}
