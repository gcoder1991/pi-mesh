import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";
import { createMeshControlTool } from "./control-extension.ts";
import { memoryPrompt } from "./memory.ts";
import { buildChildArgs, PI_MESH_PI_BINARY_ENV, resolveChildExtensions, resolveChildSkills, type ChildResult, type Usage } from "./pi-process.ts";
import { createRpcChild } from "./rpc-child.ts";
import type { MeshSettings } from "./settings.ts";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_CONVERSATION_BYTES = 1024 * 1024;

export interface SubagentRunOptions {
  id: string;
  cwd: string;
  sessionDir?: string;
  sessionFile?: string;
  prompt: string;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  persistent?: boolean;
  transcript?: boolean;
  transcriptPath?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: any) => void;
  parentContext?: string;
  mesh?: { root: string; runId: string; nodeId: string; attempt: number };
}

interface ManagedSession {
  prompt(message: string): Promise<ChildResult>;
  steer(message: string): void;
  abort(): void;
  close(): Promise<void>;
  conversation(): string;
  readonly sessionFile?: string;
}

export interface SubagentSession {
  id: string;
  session: ManagedSession;
  steer(message: string): void;
  abort(): void;
  close(): Promise<void>;
  conversation(): string;
  readonly sessionFile?: string;
}

export interface SubagentExecution extends SubagentSession {
  completion: Promise<ChildResult>;
}

type HostContext = Pick<ExtensionContext, "modelRegistry">;

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: Usage, source: any): void {
  target.turns++;
  target.input += source?.input ?? 0;
  target.output += source?.output ?? 0;
  target.cacheRead += source?.cacheRead ?? 0;
  target.cacheWrite += source?.cacheWrite ?? 0;
  target.cost += source?.cost?.total ?? 0;
  target.costInput = (target.costInput ?? 0) + (source?.cost?.input ?? 0);
  target.costOutput = (target.costOutput ?? 0) + (source?.cost?.output ?? 0);
  target.costCacheRead = (target.costCacheRead ?? 0) + (source?.cost?.cacheRead ?? 0);
  target.costCacheWrite = (target.costCacheWrite ?? 0) + (source?.cost?.cacheWrite ?? 0);
}

function messageText(message: Message): string {
  if (message.role === "user") return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  if (message.role === "assistant") return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function conversation(session: AgentSession | undefined): string {
  if (!session) return "";
  const text = session.messages.map((message) => {
    const body = messageText(message as Message).trim();
    if (message.role === "toolResult") return `[Tool Result (${message.toolName})]: ${body.slice(0, 200)}${body.length > 200 ? "..." : ""}`;
    return body ? `[${message.role === "assistant" ? "Assistant" : "User"}]: ${body}` : "";
  }).filter(Boolean).join("\n\n");
  return Buffer.byteLength(text, "utf8") <= MAX_CONVERSATION_BYTES ? text : Buffer.from(text).subarray(-MAX_CONVERSATION_BYTES).toString("utf8");
}

export class SubagentRuntime {
  private readonly settings: MeshSettings;
  private readonly host?: HostContext;
  constructor(settings: MeshSettings, host?: HostContext) {
    this.settings = settings;
    this.host = host;
    this.validateResourcePaths();
  }

  private configuredAgent(agent: AgentDefinition, options: SubagentRunOptions): AgentDefinition {
    const selectedExtensions = agent.isolated ? [] : agent.extensions ?? [];
    const selectedSkills = agent.isolated ? [] : agent.skills ?? [];
    const missingExtensions = selectedExtensions.filter((name) => !this.settings.childExtensions[name]);
    const missingSkills = selectedSkills.filter((name) => !this.settings.childSkills[name]);
    if (missingExtensions.length || missingSkills.length) throw new Error(`Unapproved child resources: ${[...missingExtensions.map((name) => `extension:${name}`), ...missingSkills.map((name) => `skill:${name}`)].join(", ")}`);
    if (selectedExtensions.some((name) => ["pi-mesh", "pi-subagents", "subagents"].includes(name.toLowerCase()))) throw new Error("Agent-management extensions cannot be loaded inside a child");
    return { ...agent, extensions: selectedExtensions, skills: selectedSkills, model: options.model ?? agent.model, thinking: options.thinking ?? agent.thinking };
  }

  private connectProcess(agent: AgentDefinition, options: SubagentRunOptions): { connection: SubagentSession; prompt: string } {
    const configured = this.configuredAgent(agent, options);
    const sessionDir = options.persistent || agent.persistSession ? options.sessionDir ?? path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions") : undefined;
    const transcriptPath = options.transcript === false || agent.outputTranscript === false ? undefined : options.transcriptPath ?? path.join(os.tmpdir(), "pi-mesh-subagents", options.id, "conversation.jsonl");
    const built = buildChildArgs(configured, options.prompt, configured.model, {
      extensions: resolveChildExtensions(configured, this.settings.childExtensions),
      skills: resolveChildSkills(configured, this.settings.childSkills),
      sessionDir,
      sessionId: sessionDir ? options.id : undefined,
      meshControl: Boolean(options.mesh),
    });
    const args: string[] = [];
    for (let index = 0; index < built.args.length; index++) {
      const value = built.args[index]!;
      if (value === "--mode") { index++; continue; }
      if (["json", "--print", "--no-session"].includes(value)) continue;
      if (value.startsWith("Task: ")) continue;
      args.push(value);
    }
    const meshEnv = options.mesh ? { PI_MESH_RUN_ID: options.mesh.runId, PI_MESH_NODE_ID: options.mesh.nodeId, PI_MESH_ATTEMPT: String(options.mesh.attempt), PI_MESH_ROOT: options.mesh.root } : {};
    const rpc = createRpcChild(configured, options.cwd, { args, env: { ...options.env, ...meshEnv }, transcriptPath, maxTurns: options.maxTurns ?? agent.maxTurns, onEvent: options.onEvent });
    const inherited = options.parentContext ? `\n\n## Parent conversation context\n${Buffer.from(options.parentContext).subarray(-128 * 1024).toString("utf8")}` : "";
    const prompt = `Task: ${options.prompt}${inherited}${memoryPrompt(configured, options.cwd)}`;
    const managed: ManagedSession = {
      prompt: (message) => rpc.prompt(message),
      steer: (message) => rpc.steer(message),
      abort: () => rpc.abort(),
      close: async () => { try { await rpc.close(); } finally { built.cleanup(); } },
      conversation: () => rpc.conversation(),
    };
    return { connection: { id: options.id, session: managed, steer: managed.steer, abort: managed.abort, close: managed.close, conversation: managed.conversation }, prompt };
  }

  private connectInProcess(agent: AgentDefinition, options: SubagentRunOptions): { connection: SubagentSession; prompt: string } {
    if (!this.host) throw new Error("In-process subagents require the Host model runtime");
    const configured = this.configuredAgent(agent, options);
    const extensions = resolveChildExtensions(configured, this.settings.childExtensions);
    const skills = resolveChildSkills(configured, this.settings.childSkills);
    const persistent = options.persistent || agent.persistSession;
    const sessionDir = persistent ? options.sessionDir ?? path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions") : undefined;
    const transcriptPath = options.transcript === false || agent.outputTranscript === false ? undefined : options.transcriptPath ?? path.join(os.tmpdir(), "pi-mesh-subagents", options.id, "conversation.jsonl");
    const managedPrompt = `${configured.systemPrompt}\n\nYou are a managed sub-agent. Do not create or commit topology changes; use mesh_control grow when Host-approved growth is available.`;
    const model = configured.model?.includes("/") ? this.host.modelRegistry.find(configured.model.slice(0, configured.model.indexOf("/")), configured.model.slice(configured.model.indexOf("/") + 1)) : undefined;
    if (configured.model && !model) throw new Error(`Model not found in Host runtime: ${configured.model}`);
    const parentModelRuntime = (this.host.modelRegistry as unknown as { runtime?: unknown }).runtime;
    if (!parentModelRuntime) throw new Error("Host model runtime is unavailable");
    const customTools = options.mesh ? [createMeshControlTool(options.mesh.root, options.mesh.runId, options.mesh.nodeId, options.mesh.attempt)] : [];
    const explicitTools = configured.tools ? [...new Set([...configured.tools, ...customTools.map((tool) => tool.name)])] : undefined;
    const disallowedTools = configured.disallowedTools?.filter((tool) => !options.mesh || tool !== "mesh_control");
    const settingsManager = SettingsManager.create(options.cwd, getAgentDir());
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: extensions,
      noSkills: true,
      additionalSkillPaths: skills,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: configured.promptMode === "replace",
      ...(configured.promptMode === "replace"
        ? { systemPromptOverride: () => managedPrompt, appendSystemPromptOverride: () => [] }
        : { appendSystemPromptOverride: (base: string[]) => [...base, managedPrompt] }),
    });

    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    let aborted = false;
    let running = false;
    const queuedSteers: string[] = [];
    if (transcriptPath) fs.mkdirSync(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });
    const record = (event: AgentSessionEvent) => {
      options.onEvent?.(event);
      if (!transcriptPath) return;
      try {
        const line = `${JSON.stringify(event)}\n`;
        let size = 0; try { size = fs.statSync(transcriptPath).size; } catch {}
        if (size + Buffer.byteLength(line, "utf8") <= MAX_TRANSCRIPT_BYTES) fs.appendFileSync(transcriptPath, line, { mode: 0o600 });
      } catch {}
    };
    const ready = (async () => {
      await resourceLoader.reload();
      const sessionManager = options.sessionFile
        ? SessionManager.open(options.sessionFile, sessionDir, options.cwd)
        : persistent ? SessionManager.create(options.cwd, sessionDir) : SessionManager.inMemory(options.cwd);
      const sessionOptions: Parameters<typeof createAgentSession>[0] & { modelRegistry?: ExtensionContext["modelRegistry"] } = {
        cwd: options.cwd,
        agentDir: getAgentDir(),
        sessionManager,
        settingsManager,
        resourceLoader,
        modelRegistry: this.host!.modelRegistry,
        modelRuntime: parentModelRuntime as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["modelRuntime"]>,
        model: model as Model<any> | undefined,
        tools: explicitTools,
        excludeTools: disallowedTools,
        customTools,
      };
      if (configured.tools?.length === 0 && customTools.length === 0) sessionOptions.noTools = "all";
      if (configured.thinking) sessionOptions.thinkingLevel = configured.thinking as NonNullable<typeof sessionOptions.thinkingLevel>;
      const created = await createAgentSession(sessionOptions);
      session = created.session;
      session.setSessionName(configured.name);
      unsubscribe = session.subscribe(record);
      await session.bindExtensions({ onError: (error) => options.onEvent?.({ type: "extension_error", error }) });
      if (aborted) await session.abort();
      return session;
    })();

    const managed: ManagedSession = {
      get sessionFile() { return session?.sessionFile; },
      async prompt(message) {
        if (closed) throw new Error("Agent session is closed");
        if (running) throw new Error("Agent session is already running");
        running = true;
        const usage = emptyUsage();
        let active: AgentSession;
        try { active = await ready; }
        catch (cause) {
          running = false;
          const error = cause instanceof Error ? cause.message : String(cause);
          return { exitCode: 1, signal: null, output: "", stderr: "", usage, model: configured.model, error };
        }
        if (aborted) { running = false; return { exitCode: 1, signal: null, output: "", stderr: "", usage, model: configured.model, error: "Child cancelled" }; }
        let output = "";
        let modelName: string | undefined;
        let error: string | undefined;
        let softLimitReached = false;
        const maxTurns = options.maxTurns ?? agent.maxTurns;
        const startIndex = active.messages.length;
        const turnEvents = active.subscribe((event) => {
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          addUsage(usage, event.message.usage);
          const text = messageText(event.message as Message).trim();
          if (text) output = text;
          modelName = `${event.message.provider}/${event.message.model}`;
          if (event.message.stopReason === "error") error = event.message.errorMessage?.trim() || "Provider error";
          if (maxTurns && usage.turns >= maxTurns && !softLimitReached) {
            softLimitReached = true;
            void active.steer("Wrap up immediately and provide your final answer now.");
          } else if (maxTurns && usage.turns >= maxTurns + 5) {
            aborted = true;
            void active.abort();
          }
        });
        try {
          const prompting = active.prompt(message);
          queueMicrotask(() => { for (const steer of queuedSteers.splice(0)) void active.steer(steer); });
          await prompting;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        } finally {
          turnEvents();
          running = false;
        }
        if (!output) {
          for (let index = active.messages.length - 1; index >= startIndex; index--) {
            const candidate = active.messages[index];
            if (candidate?.role === "assistant") { output = messageText(candidate as Message).trim(); if (output) break; }
          }
        }
        if (aborted) error = "Child cancelled";
        else if (!error && !output) error = "Child produced no output";
        return { exitCode: error ? 1 : 0, signal: null, output, stderr: "", usage, model: modelName ?? configured.model, error };
      },
      steer(message) { if (session && running) void session.steer(message); else queuedSteers.push(message); },
      abort() { aborted = true; if (session) void session.abort(); },
      async close() {
        if (closed) return;
        closed = true;
        try { const active = await ready; if (running) await active.abort(); }
        catch {}
        finally { unsubscribe?.(); session?.dispose(); }
      },
      conversation: () => conversation(session),
    };
    const inherited = options.parentContext ? `\n\n## Parent conversation context\n${Buffer.from(options.parentContext).subarray(-128 * 1024).toString("utf8")}` : "";
    const prompt = `Task: ${options.prompt}${inherited}${memoryPrompt(configured, options.cwd)}`;
    const connection: SubagentSession = {
      id: options.id,
      session: managed,
      get sessionFile() { return managed.sessionFile; },
      steer: (message) => managed.steer(message),
      abort: () => managed.abort(),
      close: () => managed.close(),
      conversation: () => managed.conversation(),
    };
    return { connection, prompt };
  }

  private connectInternal(agent: AgentDefinition, options: SubagentRunOptions): { connection: SubagentSession; prompt: string } {
    // ponytail: keep the old transport only as the existing test hook; normal Host execution is always in-process.
    return process.env[PI_MESH_PI_BINARY_ENV]?.trim() ? this.connectProcess(agent, options) : this.connectInProcess(agent, options);
  }

  connect(agent: AgentDefinition, options: SubagentRunOptions): SubagentSession {
    return this.connectInternal(agent, options).connection;
  }

  start(agent: AgentDefinition, options: SubagentRunOptions): SubagentExecution {
    const { connection, prompt } = this.connectInternal(agent, options);
    return { ...connection, get sessionFile() { return connection.sessionFile; }, completion: connection.session.prompt(prompt) };
  }

  validateResourcePaths(): void {
    for (const [kind, values] of [["extension", this.settings.childExtensions], ["skill", this.settings.childSkills]] as const) {
      for (const [name, value] of Object.entries(values)) {
        let link: fs.Stats; let stat: fs.Stats;
        try { link = fs.lstatSync(value); stat = fs.statSync(value); } catch { throw new Error(`Configured child ${kind} does not exist: ${name} -> ${value}`); }
        if (link.isSymbolicLink()) throw new Error(`Configured child ${kind} cannot be a symlink: ${name}`);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Configured child ${kind} is not a file or directory: ${name}`);
      }
    }
  }
}
