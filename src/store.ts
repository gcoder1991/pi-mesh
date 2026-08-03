import * as fs from "node:fs";
import * as path from "node:path";
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
  ackedAt?: number;
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
  error?: string;
}

export function meshDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "mesh");
}

export function atomicWriteContent(file: string, content: string | Buffer): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const handle = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(handle, content);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(temp, file);
    try {
      const directory = fs.openSync(dir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  } finally { fs.rmSync(temp, { force: true }); }
}

export function atomicWrite(file: string, value: unknown): void {
  atomicWriteContent(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid JSON state ${file}: ${error instanceof Error ? error.message : String(error)}`);
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
  const runs = listRunFiles(cwd).map((file) => ({ file, run: readJson<{ id: string; status: string; finishedAt?: number; updatedAt?: number }>(file) }))
    .filter((entry): entry is { file: string; run: { id: string; status: string; finishedAt?: number; updatedAt?: number } } => Boolean(entry.run && terminal.has(entry.run.status)))
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

export function putMessage(cwd: string, message: ControlMessage, limits?: { payloadMaxBytes: number; recipientUnreadMaxBytes: number }): void {
  const payloadBytes = Buffer.byteLength(message.content, "utf8");
  if (limits && payloadBytes > limits.payloadMaxBytes) throw new Error(`Message payload exceeds ${limits.payloadMaxBytes} bytes`);
  const dir = spoolDir(cwd, "messages", message.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, `.recipient-${Buffer.from(message.to).toString("hex")}.lock`);
  const openLock = (): number => {
    try { return fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < 60_000) throw new Error(`Recipient ${message.to} mailbox is busy`);
        fs.rmSync(lock, { force: true });
        return fs.openSync(lock, "wx", 0o600);
      } catch (retryError) {
        if (retryError instanceof Error && retryError.message === `Recipient ${message.to} mailbox is busy`) throw retryError;
        throw new Error(`Recipient ${message.to} mailbox is busy`);
      }
    }
  };
  let handle: number | undefined;
  try {
    if (limits) {
      handle = openLock();
      const unreadBytes = messages(cwd, message.runId).filter((item) => item.to === message.to && !item.ackedAt)
        .reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
      if (unreadBytes + payloadBytes > limits.recipientUnreadMaxBytes) throw new Error(`Recipient ${message.to} unread mailbox exceeds ${limits.recipientUnreadMaxBytes} bytes`);
    }
    atomicWrite(path.join(dir, `${message.id}.json`), message);
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
      fs.rmSync(lock, { force: true });
    }
  }
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
