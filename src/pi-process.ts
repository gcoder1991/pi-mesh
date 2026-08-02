import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "./agents.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const CONTROL_EXTENSION = fileURLToPath(new URL("./control-extension.ts", import.meta.url));
export const PI_MESH_PI_BINARY_ENV = "PI_MESH_PI_BINARY";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  turns: number;
}

export interface ChildResult { exitCode: number; signal: NodeJS.Signals | null; output: string; stderr: string; usage: Usage; model?: string; error?: string }

export interface ChildExecution {
  process: ChildProcessByStdio<null, Readable, Readable>;
  completion: Promise<ChildResult>;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= limit) return combined;
  let start = combined.length - limit;
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
  return combined.subarray(start);
}

function packageRootFromEntry(entry: string): string | undefined {
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const packageJson = path.join(dir, "package.json");
    try {
      if (JSON.parse(fs.readFileSync(packageJson, "utf8")).name === PI_PACKAGE) return dir;
    } catch {}
    dir = path.dirname(dir);
  }
  return undefined;
}

function resolvePiScript(): string | undefined {
  try {
    const current = process.argv[1] && fs.realpathSync(process.argv[1]);
    if (current && packageRootFromEntry(current)) return current;
  } catch {}

  try {
    const root = packageRootFromEntry(fileURLToPath(import.meta.resolve(PI_PACKAGE)));
    if (!root) return undefined;
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.pi ?? Object.values(packageJson.bin ?? {})[0];
    if (!bin) return undefined;
    const candidate = path.join(root, bin);
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function getPiInvocation(args: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const override = env[PI_MESH_PI_BINARY_ENV]?.trim();
  if (override) return { command: override, args };
  const script = resolvePiScript();
  return script ? { command: process.execPath, args: [script, ...args] } : { command: "pi", args };
}

function textFromMessage(message: Message): string {
  if (message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function buildChildArgs(agent: AgentDefinition, task: string, model?: string, resources?: { extensions?: string[]; skills?: string[]; sessionDir?: string; sessionId?: string }): { args: string[]; cleanup: () => void } {
  const args = ["--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills", "-e", CONTROL_EXTENSION];
  for (const extension of resources?.extensions ?? []) args.push("-e", extension);
  for (const skill of resources?.skills ?? []) args.push("--skill", skill);
  if (resources?.sessionDir) args.push("--session-dir", resources.sessionDir);
  if (resources?.sessionId) args.push("--session-id", resources.sessionId);
  if (model ?? agent.model) args.push("--model", model ?? agent.model!);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools) args.push(agent.tools.length ? "--tools" : "--no-tools", ...(agent.tools.length ? [agent.tools.join(",")] : []));
  if (agent.disallowedTools?.length) args.push("--exclude-tools", agent.disallowedTools.join(","));

  let tempDir: string | undefined;
  if (agent.systemPrompt) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-"));
    const promptPath = path.join(tempDir, "agent.md");
    fs.writeFileSync(promptPath, `${agent.systemPrompt}\n\nYou are a managed sub-agent. Do not create or commit topology changes; use mesh_control grow when Host-approved growth is available.`, { mode: 0o600 });
    args.push(agent.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
    if (agent.promptMode === "replace") args.push("--no-context-files");
  }
  args.push(`Task: ${task}`);
  return { args, cleanup: () => tempDir && fs.rmSync(tempDir, { recursive: true, force: true }) };
}

export function resolveChildExtensions(agent: AgentDefinition, allowed: Record<string, string> = {}): string[] {
  return (agent.extensions ?? []).map((name) => allowed[name]).filter((value): value is string => Boolean(value));
}

export function resolveChildSkills(agent: AgentDefinition, allowed: Record<string, string> = {}): string[] {
  return (agent.skills ?? []).map((name) => allowed[name]).filter((value): value is string => Boolean(value));
}

export function startChild(agent: AgentDefinition, task: string, cwd: string, signal?: AbortSignal, model?: string, env?: NodeJS.ProcessEnv, resources?: { extensions?: string[]; skills?: string[]; sessionDir?: string }): ChildExecution {
  const { args, cleanup } = buildChildArgs(agent, task, model, resources);
  const invocation = getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: { ...process.env, ...env, PI_MESH_CHILD: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const completion = new Promise<Awaited<ChildExecution["completion"]>>((resolve) => {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let output = "";
    let modelName: string | undefined;
    let spawnError: string | undefined;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let hardDrainTimer: NodeJS.Timeout | undefined;
    let exited = false;

    const parseLine = (line: Buffer) => {
      if (!line.length) return;
      try {
        const event = JSON.parse(line.toString("utf8")) as { type?: string; message?: Message };
        if ((event.type === "message_end" || event.type === "tool_result_end") && event.message?.role === "assistant") {
          usage.turns++;
          usage.input += event.message.usage?.input ?? 0;
          usage.output += event.message.usage?.output ?? 0;
          usage.cacheRead += event.message.usage?.cacheRead ?? 0;
          usage.cacheWrite += event.message.usage?.cacheWrite ?? 0;
          usage.cost += event.message.usage?.cost?.total ?? 0;
          usage.costInput = (usage.costInput ?? 0) + (event.message.usage?.cost?.input ?? 0);
          usage.costOutput = (usage.costOutput ?? 0) + (event.message.usage?.cost?.output ?? 0);
          usage.costCacheRead = (usage.costCacheRead ?? 0) + (event.message.usage?.cost?.cacheRead ?? 0);
          usage.costCacheWrite = (usage.costCacheWrite ?? 0) + (event.message.usage?.cost?.cacheWrite ?? 0);
          modelName = event.message.model ?? modelName;
          spawnError = event.message.errorMessage ?? spawnError;
          const text = textFromMessage(event.message);
          if (text.trim()) output = text;
        }
      } catch {
        // JSON mode can still contain diagnostics; stderr/exit code handle failures.
      }
    };

    child.stdout.on("data", (raw: Buffer) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_LINE_BYTES && !pending.includes(0x0a)) {
        spawnError = `Child stdout line exceeded ${MAX_LINE_BYTES} bytes`;
        child.kill("SIGTERM");
        pending = Buffer.alloc(0);
        return;
      }
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (line.length > MAX_LINE_BYTES) {
          spawnError = `Child stdout line exceeded ${MAX_LINE_BYTES} bytes`;
          child.kill("SIGTERM");
          return;
        }
        parseLine(line);
      }
    });
    const armDrain = () => {
      if (!exited) return;
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000);
      drainTimer.unref?.();
    };
    child.stderr.on("data", (chunk: Buffer) => { stderrTail = appendTail(stderrTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), MAX_STDERR_BYTES); armDrain(); });
    child.stdout.on("data", armDrain);
    child.on("exit", () => {
      exited = true;
      armDrain();
      hardDrainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 5000);
      hardDrainTimer.unref?.();
    });
    child.on("error", (error) => { spawnError = error.message; });
    child.on("close", (code, closeSignal) => {
      if (pending.length <= MAX_LINE_BYTES) parseLine(pending);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (hardDrainTimer) clearTimeout(hardDrainTimer);
      signal?.removeEventListener("abort", abort);
      cleanup();
      const stderr = stderrTail.toString("utf8");
      const error = aborted ? "Child cancelled" : spawnError ?? (closeSignal ? `Pi terminated by ${closeSignal}` : code && code !== 0 ? stderr.trim() || `Pi exited with code ${code}` : !output.trim() ? "Child produced no output" : undefined);
      resolve({ exitCode: code ?? 1, signal: closeSignal, output, stderr, usage, model: modelName, error });
    });

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref?.();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

  return { process: child, completion };
}
