import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { AgentDefinition } from "./agents.ts";
import { getPiInvocation, killChildProcess, type ChildResult, type Usage } from "./pi-process.ts";

export interface RpcChildOptions {
  args: string[];
  env?: NodeJS.ProcessEnv;
  transcriptPath?: string;
  maxTurns?: number;
  graceTurns?: number;
  onEvent?: (event: any) => void;
}

interface PendingTurn {
  id: string;
  resolve: (result: ChildResult) => void;
  usage: Usage;
  output: string;
  model?: string;
  error?: string;
  turns: number;
  wrapped: boolean;
}

export interface RpcChildSession {
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  prompt(message: string): Promise<ChildResult>;
  steer(message: string): void;
  abort(): void;
  close(): Promise<void>;
  conversation(): string;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_CONVERSATION_BYTES = 1024 * 1024;
const ABORT_GRACE_MS = 3000;
function appendTail(value: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, limit: number): Buffer<ArrayBufferLike> {
  const joined = Buffer.concat([value, chunk]);
  if (joined.length <= limit) return joined;
  let start = joined.length - limit;
  while (start < joined.length && (joined[start]! & 0xc0) === 0x80) start++;
  return joined.subarray(start);
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: Usage, source: any): void {
  target.turns++;
  target.input += source?.input ?? 0; target.output += source?.output ?? 0; target.cacheRead += source?.cacheRead ?? 0; target.cacheWrite += source?.cacheWrite ?? 0;
  target.cost += source?.cost?.total ?? 0;
  target.costInput = (target.costInput ?? 0) + (source?.cost?.input ?? 0); target.costOutput = (target.costOutput ?? 0) + (source?.cost?.output ?? 0);
  target.costCacheRead = (target.costCacheRead ?? 0) + (source?.cost?.cacheRead ?? 0); target.costCacheWrite = (target.costCacheWrite ?? 0) + (source?.cost?.cacheWrite ?? 0);
}

export function createRpcChild(agent: AgentDefinition, cwd: string, options: RpcChildOptions): RpcChildSession {
  const environment = { ...process.env, ...options.env, PI_MESH_CHILD: "1" };
  const invocation = getPiInvocation(["--mode", "rpc", ...options.args], environment);
  const child = spawn(invocation.command, invocation.args, { cwd, env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  child.stdin.on("error", () => {});
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrWrites = Promise.resolve();
  let pending: PendingTurn | undefined;
  let closed = false;
  let closeResolve: (() => void) | undefined;
  const closePromise = new Promise<void>((resolve) => { closeResolve = resolve; });
  const conversation: string[] = [];
  let abortTimer: NodeJS.Timeout | undefined;
  let abortKillTimer: NodeJS.Timeout | undefined;
  if (options.transcriptPath) fs.mkdirSync(path.dirname(options.transcriptPath), { recursive: true, mode: 0o700 });
  const record = (event: any) => {
    options.onEvent?.(event);
    if (options.transcriptPath) {
      const line = `${JSON.stringify(event)}\n`;
      const size = Buffer.byteLength(line, "utf8");
      let current = 0; try { current = fs.statSync(options.transcriptPath).size; } catch {}
      if (current < MAX_CONVERSATION_BYTES) fs.appendFileSync(options.transcriptPath, Buffer.from(line).subarray(0, MAX_CONVERSATION_BYTES - current), { mode: 0o600 });
    }
  };
  const send = (value: object) => {
    if (closed || child.stdin.destroyed || !child.stdin.writable) throw new Error("Child session is closed");
    try { child.stdin.write(`${JSON.stringify(value)}\n`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
      throw new Error("Child session is closed");
    }
  };
  const finish = (extraError?: string) => {
    if (!pending) return;
    const turn = pending; pending = undefined;
    const settle = () => turn.resolve({ exitCode: extraError || turn.error ? 1 : 0, signal: null, output: turn.output, stderr: stderrTail.toString("utf8"), usage: turn.usage, model: turn.model, error: extraError ?? turn.error ?? (!turn.output.trim() ? "Child produced no output" : undefined) });
    setImmediate(() => void stderrWrites.then(settle));
  };
  const handle = (line: string) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { finish(`Child stdout line exceeded ${MAX_LINE_BYTES} bytes`); killChildProcess(child, "SIGTERM"); return; }
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method) && event.id) {
      try { send({ type: "extension_ui_response", id: event.id, cancelled: true }); } catch {}
    }
    record(event);
    if (event.type === "response" && event.success === false && pending && (!event.id || event.id === pending.id)) finish(event.error ?? "Child rejected prompt");
    if (event.type === "message_end") {
      const message = event.message;
      if (message?.role === "user") conversation.push(`[User] ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`);
      if (message?.role === "assistant") {
        if (pending) {
          addUsage(pending.usage, message.usage);
          pending.turns = pending.usage.turns;
          pending.model = message.model ?? pending.model;
          pending.error = message.errorMessage ?? pending.error;
          const text = message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
          if (text.trim()) pending.output = text;
          if (text.trim()) conversation.push(`[Assistant] ${text}`);
          if (options.maxTurns && pending.turns >= options.maxTurns && !pending.wrapped) {
            pending.wrapped = true;
            send({ type: "steer", message: "Wrap up immediately and provide your final answer now." });
          } else if (options.maxTurns && pending.turns >= options.maxTurns + (options.graceTurns ?? 5)) send({ type: "abort" });
        }
      }
    }
    if (event.type === "agent_settled") {
      if (abortTimer) { clearTimeout(abortTimer); abortTimer = undefined; }
      if (abortKillTimer) { clearTimeout(abortKillTimer); abortKillTimer = undefined; }
      finish();
    }
    if (event.type === "response" && event.command === "prompt" && event.success === true && pending) record({ type: "prompt_accepted", id: pending.id });
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      let line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.endsWith("\r")) line = line.slice(0, -1); handle(line);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) { finish(`Child stdout line exceeded ${MAX_LINE_BYTES} bytes`); killChildProcess(child, "SIGTERM"); }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const value = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    stderrWrites = stderrWrites.then(() => { stderrTail = appendTail(stderrTail, value, MAX_STDERR_BYTES); });
  });
  child.on("error", (error) => finish(error.message));
  child.on("close", (code, signal) => {
    closed = true;
    buffer += decoder.end(); if (buffer) handle(buffer);
    if (pending) {
      const turn = pending; pending = undefined;
      const settle = () => turn.resolve({ exitCode: code ?? 1, signal, output: turn.output, stderr: stderrTail.toString("utf8"), usage: turn.usage, model: turn.model, error: turn.error ?? (signal ? `Pi terminated by ${signal}` : `Pi exited with code ${code ?? 1}`) });
      setImmediate(() => void stderrWrites.then(settle));
    }
    if (abortTimer) clearTimeout(abortTimer);
    if (abortKillTimer) clearTimeout(abortKillTimer);
    closeResolve?.();
  });

  return {
    process: child,
    prompt(message) {
      if (pending) return Promise.reject(new Error("Child session is already running"));
      return new Promise<ChildResult>((resolve) => {
        const id = crypto.randomUUID();
        pending = { id, resolve, usage: emptyUsage(), output: "", turns: 0, wrapped: false };
        send({ id, type: "prompt", message });
      });
    },
    steer(message) { if (!pending) throw new Error("Child session is not running"); send({ type: "steer", message }); },
    abort() {
      if (!pending || closed) return;
      try { send({ type: "abort" }); } catch {}
      if (!abortTimer) {
        abortTimer = setTimeout(() => {
          if (closed) return;
          killChildProcess(child, "SIGTERM");
          abortKillTimer = setTimeout(() => { if (!closed) killChildProcess(child, "SIGKILL"); }, ABORT_GRACE_MS);
          abortKillTimer.unref?.();
        }, ABORT_GRACE_MS);
        abortTimer.unref?.();
      }
    },
    async close() {
      if (closed) return;
      if (pending) {
        try { send({ type: "abort" }); } catch {}
      }
      killChildProcess(child, "SIGTERM");
      const timer = setTimeout(() => killChildProcess(child, "SIGKILL"), ABORT_GRACE_MS); timer.unref?.();
      await closePromise; clearTimeout(timer);
    },
    conversation() {
      const text = conversation.join("\n\n");
      return Buffer.byteLength(text, "utf8") <= MAX_CONVERSATION_BYTES ? text : Buffer.from(text).subarray(-MAX_CONVERSATION_BYTES).toString("utf8");
    },
  };
}
