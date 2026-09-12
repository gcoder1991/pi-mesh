import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
  createEventBus,
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
import { buildChildArgs, growthPrompt, PI_MESH_PI_BINARY_ENV, resolveChildExtensions, resolveChildSkills, type ChildResult } from "./pi-process.ts";
import { createRpcChild } from "./rpc-child.ts";
import { addUsage, emptyUsage, truncateUtf8 } from "./runtime-utils.ts";
import type { MeshSettings } from "./settings.ts";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_CONVERSATION_BYTES = DEFAULT_MAX_BYTES;
// Existing component budgets: task/dependency evidence, parent context, memory,
// and managed system instructions share a single 512 KiB ceiling.
export const MAX_SUBAGENT_PROMPT_BYTES = 512 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;

export interface SubagentReady {
  readonly sessionFile?: string;
  /** New SDK sessions flush their header only on the first assistant message. */
  readonly persisted: boolean;
}

export interface HostRuntimeContext extends Pick<ExtensionContext, "modelRegistry"> {
  /** Fail closed when a Host has not supplied a trust decision. */
  projectTrusted?: boolean;
}

export interface ConversationSnapshot {
  text: string;
  truncated: boolean;
  /** Bounded event transcript, not necessarily a complete conversation. */
  artifactPath?: string;
}

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
  onReady?: (ready: SubagentReady) => void | Promise<void>;
  timeoutMs?: number;
  parentContext?: string;
  mesh?: { root: string; runId: string; nodeId: string; attempt: number; onMessageStored?: (message: import("./store.ts").ControlMessage) => void | Promise<void> };
}

interface ManagedSession {
  prompt(message: string): Promise<ChildResult>;
  steer(message: string): void;
  /** Never queue for a future prompt or submit after cancellation. */
  steerActive?(message: string): boolean;
  abort(reason?: "cancelled" | "timeout"): void;
  close(): Promise<void>;
  conversation(): string;
  conversationSnapshot(): ConversationSnapshot;
  readonly sessionFile?: string;
  readonly ready: Promise<SubagentReady>;
}

export interface SubagentSession {
  id: string;
  session: ManagedSession;
  steer(message: string): void;
  /** Never queue for a future prompt or submit after cancellation. */
  steerActive?(message: string): boolean;
  abort(reason?: "cancelled" | "timeout"): void;
  close(): Promise<void>;
  conversation(): string;
  conversationSnapshot(): ConversationSnapshot;
  readonly sessionFile?: string;
  readonly ready: Promise<SubagentReady>;
}

export interface SubagentExecution extends SubagentSession {
  completion: Promise<ChildResult>;
}

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

export const MANAGED_CHILD_IDENTITY_QUERY = "pi-mesh:runtime:identity:query";
export interface ManagedChildIdentity { readonly version: 1; readonly managed: true; readonly agentId: string; readonly runId?: string; readonly nodeId?: string; readonly attempt?: number }

function childSettings(cwd: string, projectTrusted: boolean): SettingsManager {
  const source = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  // Snapshot before constructing the loader: reload() resolves packages BEFORE
  // applying noExtensions. Overrides/filtering loaded results are too late.
  const merge = (base: Settings, project: Settings): Settings => {
    const result = { ...base } as Record<string, unknown>;
    for (const [key, value] of Object.entries(project)) {
      result[key] = value && typeof value === "object" && !Array.isArray(value)
        ? { ...(result[key] as object ?? {}), ...value } : value;
    }
    return result as Settings;
  };
  const snapshot = merge(source.getGlobalSettings(), source.getProjectSettings());
  return SettingsManager.inMemory({ ...snapshot, packages: [], extensions: [], skills: [], prompts: [], themes: [] }, { projectTrusted });
}

function validateSessionFile(file: string, roots: string[]): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || path.extname(file) !== ".jsonl") throw new Error("expected a regular, non-symlink .jsonl file");
    const real = fs.realpathSync(file);
    if (!roots.some((root) => {
      try { const relative = path.relative(fs.realpathSync(root), real); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
      catch { return false; }
    })) throw new Error("path escapes the approved child session directory");
    // SDK open creates new sessions for missing/empty files. Require a real
    // header first, without reading an unbounded JSONL file into memory.
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytes).toString("utf8");
      const line = prefix.split("\n").find((value) => value.trim());
      const header = line ? JSON.parse(line) : undefined;
      if (header?.type !== "session" || typeof header.id !== "string" || !header.id) throw new Error("missing valid session header");
    } finally { fs.closeSync(fd); }
  } catch (cause) {
    throw new Error(`Cannot resume child session ${file}: ${cause instanceof Error ? cause.message : String(cause)}. Restore the original session file or explicitly start a new agent.`);
  }
}

function boundedPrompt(text: string, limit: number): string {
  const marker = "\n[truncated: prompt budget]";
  return Buffer.byteLength(text, "utf8") <= limit ? text : `${truncateUtf8(text, limit - Buffer.byteLength(marker))}${marker}`;
}

function initialPrompt(agent: AgentDefinition, options: SubagentRunOptions): string {
  const inherited = options.parentContext ? `\n\n## Parent conversation context\n${boundedPrompt(options.parentContext, 128 * 1024)}` : "";
  return boundedPrompt(`Task: ${boundedPrompt(options.prompt, 64 * 1024)}${inherited}${memoryPrompt(agent, options.cwd)}`, MAX_SUBAGENT_PROMPT_BYTES - MAX_SYSTEM_PROMPT_BYTES);
}

function messageText(message: Message): string {
  if (message.role === "user") return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  if (message.role === "assistant") return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function conversation(session: AgentSession | undefined, artifactPath?: string): ConversationSnapshot {
  if (!session) return { text: "", truncated: false, artifactPath };
  // Walk newest first; never map/join the entire SDK history (or tool payload).
  let text = "";
  let truncated = false;
  const limit = MAX_CONVERSATION_BYTES - 1024;
  outer: for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]!;
    if (!("content" in message)) continue;
    const content = message.content;
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    let body = "";
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]!;
      if (part.type !== "text") continue;
      const remaining = Math.max(0, limit - Buffer.byteLength(text) - Buffer.byteLength(body) - (body ? 1 : 0));
      if (Buffer.byteLength(part.text) > remaining) truncated = true;
      body = `${truncateUtf8(part.text, remaining, "tail")}${body ? `\n${body}` : ""}`;
      if (truncated) break;
    }
    const label = message.role === "toolResult" ? `Tool Result (${message.toolName})` : message.role === "assistant" ? "Assistant" : "User";
    const next = body ? `[${label}]: ${body}${text ? `\n\n${text}` : ""}` : text;
    if (Buffer.byteLength(next) > limit) truncated = true;
    text = truncateUtf8(next, limit, "tail");
    if (truncated) break outer;
  }
  const bounded = truncateTail(text, { maxBytes: limit, maxLines: DEFAULT_MAX_LINES - 2 });
  truncated ||= bounded.truncated;
  const marker = truncated ? `[truncated conversation${artifactPath ? `; bounded transcript: ${artifactPath}` : ""}]\n` : "";
  return { text: `${boundedPrompt(marker, 1024)}${bounded.content}`, truncated, artifactPath };
}

export class SubagentRuntime {
  private readonly settings: MeshSettings;
  private readonly host?: HostRuntimeContext;
  constructor(settings: MeshSettings, host?: HostRuntimeContext) {
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
    const prompt = initialPrompt(configured, options);
    const sessionDir = options.persistent || agent.persistSession ? options.sessionDir ?? path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions") : undefined;
    const transcriptPath = options.transcript === false || agent.outputTranscript === false ? undefined : options.transcriptPath ?? path.join(os.tmpdir(), "pi-mesh-subagents", options.id, "conversation.jsonl");
    // The legacy hook spawns before its own transcript mkdir; preflight here so
    // a bad artifact directory cannot strand a child or its temporary prompt.
    if (transcriptPath) fs.mkdirSync(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });
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
    if (options.sessionFile) args.push("--session", options.sessionFile);
    let rpc: ReturnType<typeof createRpcChild>;
    let sessionFile = options.sessionFile;
    let resolveState: ((ready: SubagentReady) => void) | undefined;
    let rejectState: ((error: Error) => void) | undefined;
    const state = sessionDir ? new Promise<SubagentReady>((resolve, reject) => { resolveState = resolve; rejectState = reject; }) : Promise.resolve({ persisted: false });
    try { rpc = createRpcChild(configured, options.cwd, { args, env: { ...options.env, ...meshEnv }, transcriptPath, maxTurns: options.maxTurns ?? agent.maxTurns, onEvent: (event) => {
      if (event.type === "response" && event.command === "get_state" && event.id === "mesh-ready") {
        if (!event.success) rejectState?.(new Error(event.error ?? "Child get_state failed"));
        else {
          sessionFile = event.data?.sessionFile;
          resolveState?.({ sessionFile, persisted: Boolean(sessionFile && fs.existsSync(sessionFile)) });
        }
      }
      options.onEvent?.(event);
    } }); }
    catch (cause) { built.cleanup(); throw cause; }
    const stateClosed = () => rejectState?.(new Error("Child closed before session readiness"));
    rpc.process.once("close", stateClosed);
    const stateTimer = sessionDir ? setTimeout(() => rejectState?.(new Error("Child session readiness timed out")), 5000) : undefined;
    if (sessionDir) rpc.process.stdin.write(`${JSON.stringify({ id: "mesh-ready", type: "get_state" })}\n`);
    const ready = state.then(async (evidence) => { await options.onReady?.(evidence); return evidence; }).finally(() => {
      if (stateTimer) clearTimeout(stateTimer); rpc.process.removeListener("close", stateClosed);
    });
    let closePromise: Promise<void> | undefined;
    let closed = false;
    let running = false;
    let rpcRunning = false;
    let abortReason: "cancelled" | "timeout" | undefined;
    const queuedSteers: string[] = [];
    const close = () => {
      closed = true;
      if (running) { abortReason ??= "cancelled"; rpc.abort(); }
      return closePromise ??= (async () => {
        try { await ready; } catch { /* retain initialization errors on ready */ }
        try { await rpc.close(); } finally { built.cleanup(); }
      })();
    };
    void ready.catch(close).catch(() => {});
    const snapshot = (): ConversationSnapshot => {
      const bounded = truncateTail(rpc.conversation(), { maxBytes: MAX_CONVERSATION_BYTES - 1024, maxLines: DEFAULT_MAX_LINES - 2 });
      const marker = bounded.truncated ? `[truncated conversation${transcriptPath ? `; bounded transcript: ${transcriptPath}` : ""}]\n` : "";
      return { text: `${boundedPrompt(marker, 1024)}${bounded.content}`, truncated: bounded.truncated, artifactPath: transcriptPath };
    };
    const managed: ManagedSession = {
      get sessionFile() { return sessionFile; },
      ready,
      prompt: async (message) => {
        if (closed) throw new Error("Agent session is closed");
        if (running) throw new Error("Agent session is already running");
        running = true;
        let timer: NodeJS.Timeout | undefined;
        try {
          await ready;
          if (abortReason) return { exitCode: 1, signal: null, output: "", stderr: "", usage: emptyUsage(), error: `Child ${abortReason}`, stopReason: abortReason, partial: true };
          timer = options.timeoutMs ? setTimeout(() => managed.abort("timeout"), options.timeoutMs) : undefined;
          const prompting = rpc.prompt(boundedPrompt(message, MAX_SUBAGENT_PROMPT_BYTES - MAX_SYSTEM_PROMPT_BYTES));
          rpcRunning = true;
          for (const steer of queuedSteers.splice(0)) rpc.steer(steer);
          const result = await prompting;
          const maxTurns = options.maxTurns ?? agent.maxTurns;
          const stopReason = abortReason ?? (result.error ? "error" : maxTurns && result.usage.turns >= maxTurns ? "maxTurns" : "completed");
          return { ...result, stopReason, partial: stopReason !== "completed" };
        } finally { running = false; rpcRunning = false; if (timer) clearTimeout(timer); }
      },
      steer: (message) => { if (closed) return; if (rpcRunning) rpc.steer(message); else if (queuedSteers.length < 32) queuedSteers.push(boundedPrompt(message, 64 * 1024)); },
      steerActive: (message) => { if (closed || abortReason || !rpcRunning) return false; rpc.steer(boundedPrompt(message, 64 * 1024)); return true; },
      abort: (reason = "cancelled") => { abortReason ??= reason; rpc.abort(); },
      close,
      conversation: () => snapshot().text,
      conversationSnapshot: snapshot,
    };
    return { connection: { id: options.id, get sessionFile() { return sessionFile; }, ready, conversationSnapshot: managed.conversationSnapshot, session: managed, steer: managed.steer, steerActive: managed.steerActive, abort: managed.abort, close: managed.close, conversation: managed.conversation }, prompt };
  }

  private connectInProcess(agent: AgentDefinition, options: SubagentRunOptions): { connection: SubagentSession; prompt: string } {
    if (!this.host) throw new Error("In-process subagents require the Host model runtime");
    const configured = this.configuredAgent(agent, options);
    const prompt = initialPrompt(configured, options);
    const extensions = resolveChildExtensions(configured, this.settings.childExtensions);
    const skills = resolveChildSkills(configured, this.settings.childSkills);
    const persistent = options.persistent || agent.persistSession;
    const sessionDir = persistent ? options.sessionDir ?? path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions") : undefined;
    const transcriptPath = options.transcript === false || agent.outputTranscript === false ? undefined : options.transcriptPath ?? path.join(os.tmpdir(), "pi-mesh-subagents", options.id, "conversation.jsonl");
    const guidance = boundedPrompt(growthPrompt(configured, Boolean(options.mesh)), MAX_SYSTEM_PROMPT_BYTES / 2);
    const managedPrompt = `${boundedPrompt(configured.systemPrompt, MAX_SYSTEM_PROMPT_BYTES - Buffer.byteLength(guidance) - 2)}\n\n${guidance}`;
    const preserveManaged = (base: string): string => {
      const budget = Math.max(0, MAX_SYSTEM_PROMPT_BYTES - Buffer.byteLength(managedPrompt) - 2);
      const context = base.replace(managedPrompt, "");
      return budget > 64 ? `${boundedPrompt(context, budget)}\n\n${managedPrompt}` : managedPrompt;
    };
    const model = configured.model?.includes("/") ? this.host.modelRegistry.find(configured.model.slice(0, configured.model.indexOf("/")), configured.model.slice(configured.model.indexOf("/") + 1)) : undefined;
    if (configured.model && !model) throw new Error(`Model not found in Host runtime: ${configured.model}`);
    const parentModelRuntime = (this.host.modelRegistry as unknown as { runtime?: unknown }).runtime;
    if (!parentModelRuntime) throw new Error("Host model runtime is unavailable");
    const customTools = options.mesh ? [createMeshControlTool(options.mesh.root, options.mesh.runId, options.mesh.nodeId, options.mesh.attempt, options.mesh.onMessageStored)] : [];
    const explicitTools = configured.tools ? [...new Set([...configured.tools, ...customTools.map((tool) => tool.name)])] : undefined;
    const disallowedTools = configured.disallowedTools?.filter((tool) => !options.mesh || tool !== "mesh_control");
    const projectTrusted = this.host.projectTrusted ?? false;
    const settingsManager = childSettings(options.cwd, projectTrusted);
    let systemPromptTruncated = managedPrompt.includes("[truncated: prompt budget]");
    const events = createEventBus();
    const identity: ManagedChildIdentity = Object.freeze({ version: 1, managed: true, agentId: options.id, ...(options.mesh ? { runId: options.mesh.runId, nodeId: options.mesh.nodeId, attempt: options.mesh.attempt } : {}) });
    const approvedSkill = (file: string): boolean => skills.some((root) => {
      const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
      return relative === "" || (fs.statSync(root).isDirectory() && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
    // SDK path factories run before inline factories. Install identity on the
    // public, child-local EventBus BEFORE reload can execute any approved path
    // (including a differently named alias of Mesh). No process-global flag.
    const offIdentity = events.on(MANAGED_CHILD_IDENTITY_QUERY, (data) => {
      const request = data as { version?: unknown; reply?: unknown } | undefined;
      if (request?.version === 1 && typeof request.reply === "function") request.reply(identity);
    });
    const resourceLoader = new DefaultResourceLoader({
      eventBus: events,
      extensionFactories: [(pi) => {
        pi.on("session_shutdown", () => { offIdentity(); });
        pi.on("before_agent_start", (event) => {
          // Include SDK-added AGENTS/skills/base prompt in the same system slice.
          if (Buffer.byteLength(event.systemPrompt) <= MAX_SYSTEM_PROMPT_BYTES && event.systemPrompt.includes(managedPrompt)) return;
          systemPromptTruncated = true;
          return { systemPrompt: preserveManaged(event.systemPrompt) };
        });
      }],
      // Approved extension packages may bundle other resource kinds. They are
      // not an implicit skill/prompt/theme allowlist.
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => approvedSkill(skill.filePath)) }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      cwd: options.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: extensions,
      noSkills: true,
      additionalSkillPaths: skills,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: !projectTrusted || configured.promptMode === "replace",
      ...(configured.promptMode === "replace"
        ? { systemPromptOverride: () => managedPrompt, appendSystemPromptOverride: () => [] }
        : { appendSystemPromptOverride: (base: string[]) => [preserveManaged(base.reduce((text, part) => text.length >= MAX_SYSTEM_PROMPT_BYTES ? text : boundedPrompt(`${text}\n\n${boundedPrompt(part, MAX_SYSTEM_PROMPT_BYTES)}`, MAX_SYSTEM_PROMPT_BYTES), ""))] }),
    });

    const extendResources = resourceLoader.extendResources.bind(resourceLoader);
    resourceLoader.extendResources = (paths) => extendResources({ skillPaths: paths.skillPaths?.filter((entry) => approvedSkill(entry.path)) });

    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    let abortReason: "cancelled" | "timeout" | undefined;
    let closePromise: Promise<void> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let promptSettled: Promise<void> = Promise.resolve();
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
    const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
      try {
        // 0.83 does not root-export emitSessionShutdownEvent. The public runner
        // emits the same event while the extension API is still valid.
        if (session) {
          try { await session.abort(); }
          finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        } else {
          // reload can retain successfully loaded factories even when a sibling
          // failed before a session exists. Their shutdown hooks still need to run.
          // No session_start or bound-core API is fabricated for this temporary runner.
          const loaded = resourceLoader.getExtensions();
          if (loaded.extensions.length) await new ExtensionRunner(loaded.extensions, loaded.runtime, options.cwd, SessionManager.inMemory(options.cwd), this.host!.modelRegistry).emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        try { unsubscribe?.(); session?.dispose(); } finally { events.clear(); }
      }
    })();
    const ready = (async (): Promise<SubagentReady> => {
      try {
        await resourceLoader.reload();
        const extensionErrors = resourceLoader.getExtensions().errors;
        if (extensionErrors.length) throw new Error(`Child extension initialization failed: ${extensionErrors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
        if (options.sessionFile) validateSessionFile(options.sessionFile, options.sessionDir ? [options.sessionDir] : [path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions"), path.join(options.cwd, CONFIG_DIR_NAME, "sessions")]);
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
        if (abortReason) await session.abort();
        const evidence = { sessionFile: session.sessionFile, persisted: Boolean(session.sessionFile && fs.existsSync(session.sessionFile)) };
        await options.onReady?.(evidence);
        return evidence;
      } catch (cause) {
        try { await cleanup(); } catch { /* preserve the initialization diagnostic */ }
        throw cause;
      }
    })();
    // connect() is also used without prompting. Keep rejection observable through
    // ready, but never leak an unhandled rejection during initialization failure.
    void ready.catch(() => {});

    const managed: ManagedSession = {
      ready,
      get sessionFile() { return session?.sessionFile; },
      async prompt(message) {
        if (closed) throw new Error("Agent session is closed");
        if (running) throw new Error("Agent session is already running");
        running = true;
        let settle!: () => void;
        promptSettled = new Promise<void>((resolve) => { settle = resolve; });
        const usage = emptyUsage();
        let active: AgentSession;
        try { await ready; active = session!; }
        catch (cause) {
          running = false;
          settle();
          const error = cause instanceof Error ? cause.message : String(cause);
          return { exitCode: 1, signal: null, output: "", stderr: "", usage, model: configured.model, error, stopReason: "error", partial: true };
        }
        if (abortReason) { running = false; settle(); return { exitCode: 1, signal: null, output: "", stderr: "", usage, model: configured.model, error: `Child ${abortReason}`, stopReason: abortReason, partial: true }; }
        let output = "";
        let modelName: string | undefined;
        let error: string | undefined;
        let softLimitReached = false;
        let hardLimitReached = false;
        const maxTurns = options.maxTurns ?? agent.maxTurns;
        const startIndex = active.messages.length;
        const prepareNextTurn = active.agent.prepareNextTurnWithContext;
        const streamFunction = active.agent.streamFunction;
        let blockedRequest = false;
        active.agent.streamFunction = (...args) => {
          // Covers retry's first turn and async before_agent_start preflight too.
          if (hardLimitReached || abortReason) { blockedRequest = true; throw new Error("Child execution stopped before provider request"); }
          return streamFunction(...args);
        };
        active.agent.prepareNextTurnWithContext = (turn, signal) => {
          // SDK abort signals cancel tools/transport, but its loop may still ask
          // for another turn. Do not start more provider work after a hard stop.
          if (hardLimitReached || abortReason) throw new Error("Child execution stopped before next turn");
          return prepareNextTurn?.(turn, signal);
        };
        const turnEvents = active.subscribe((event) => {
          if (event.type !== "message_end" || event.message.role !== "assistant" || blockedRequest) return;
          addUsage(usage, event.message.usage);
          const text = messageText(event.message as Message).trim();
          if (text) output = text;
          modelName = `${event.message.provider}/${event.message.model}`;
          error = event.message.stopReason === "error" ? event.message.errorMessage?.trim() || "Provider error" : event.message.stopReason === "aborted" ? "Provider aborted" : undefined;
          if (maxTurns && usage.turns >= maxTurns && !softLimitReached) {
            softLimitReached = true;
            void active.steer("Wrap up immediately and provide your final answer now.").catch(() => {});
          } else if (maxTurns && usage.turns >= maxTurns + 5) {
            hardLimitReached = true;
            void active.abort().catch(() => {});
          }
        });
        const timer = options.timeoutMs ? setTimeout(() => managed.abort("timeout"), options.timeoutMs) : undefined;
        const boundedMessage = boundedPrompt(message, MAX_SUBAGENT_PROMPT_BYTES - MAX_SYSTEM_PROMPT_BYTES);
        try {
          const prompting = active.prompt(boundedMessage);
          queueMicrotask(() => { for (const steer of queuedSteers.splice(0)) void active.steer(steer).catch(() => {}); });
          await prompting;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        } finally {
          if (timer) clearTimeout(timer);
          turnEvents();
          active.agent.prepareNextTurnWithContext = prepareNextTurn;
          active.agent.streamFunction = streamFunction;
          running = false;
          settle();
        }
        if (!output) {
          for (let index = active.messages.length - 1; index >= startIndex; index--) {
            const candidate = active.messages[index];
            if (candidate?.role === "assistant") { output = messageText(candidate as Message).trim(); if (output) break; }
          }
        }
        if (abortReason) error = `Child ${abortReason}. Review partial output before explicitly continuing.`;
        else if (hardLimitReached) error = "Child exceeded maxTurns wrap-up allowance. Review partial output and increase maxTurns or narrow the task.";
        else if (!error && !output) error = "Child produced no output. Check the provider and retry explicitly.";
        let stopReason: NonNullable<ChildResult["stopReason"]> = abortReason ?? (hardLimitReached ? "maxTurns" : error ? "error" : softLimitReached ? "maxTurns" : "completed");
        const bounded = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        let outputPath: string | undefined;
        if (bounded.truncated) {
          try {
            const dir = transcriptPath ? path.dirname(transcriptPath) : fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-output-"));
            outputPath = path.join(dir, `output-${randomUUID()}.txt`);
            fs.writeFileSync(outputPath, output, { mode: 0o600, flag: "wx" });
          } catch (cause) {
            outputPath = undefined;
            error = `${error ? `${error}; ` : ""}Cannot preserve full child output: ${cause instanceof Error ? cause.message : String(cause)}. Check artifact directory permissions and disk space.`;
            if (stopReason === "completed") stopReason = "error";
          }
          output = bounded.content || truncateUtf8(output, DEFAULT_MAX_BYTES);
        }
        return { exitCode: error ? 1 : 0, signal: null, output, stderr: "", usage, model: modelName ?? configured.model, error, stopReason, partial: stopReason !== "completed", outputTruncated: bounded.truncated, outputPath, promptTruncated: systemPromptTruncated || boundedMessage !== message || prompt.includes("[truncated: prompt budget]") };
      },
      steer(message) { if (closed) return; if (session && running) void session.steer(boundedPrompt(message, 64 * 1024)).catch(() => {}); else if (queuedSteers.length < 32) queuedSteers.push(boundedPrompt(message, 64 * 1024)); },
      steerActive(message) { if (closed || abortReason || !session || !running || !session.isStreaming) return false; void session.steer(boundedPrompt(message, 64 * 1024)).catch(() => {}); return true; },
      abort(reason = "cancelled") { abortReason ??= reason; if (session) void session.abort().catch(() => {}); },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        // Mark cancellation synchronously, including close during initialization.
        if (running) managed.abort();
        return closePromise = (async () => {
          try {
            try { await ready; } catch { /* initialization already finalized */ }
            if (session && running) await session.abort();
            await promptSettled;
          } finally { await cleanup(); }
        })();
      },
      conversation: () => conversation(session, transcriptPath).text,
      conversationSnapshot: () => conversation(session, transcriptPath),
    };
    const connection: SubagentSession = {
      id: options.id,
      ready,
      session: managed,
      get sessionFile() { return managed.sessionFile; },
      steer: (message) => managed.steer(message),
      steerActive: (message) => managed.steerActive?.(message) ?? false,
      abort: (reason) => managed.abort(reason),
      close: () => managed.close(),
      conversation: () => managed.conversation(),
      conversationSnapshot: () => managed.conversationSnapshot(),
    };
    return { connection, prompt };
  }

  private connectInternal(agent: AgentDefinition, options: SubagentRunOptions): { connection: SubagentSession; prompt: string } {
    if (options.sessionFile !== undefined) validateSessionFile(options.sessionFile, options.sessionDir
      ? [options.sessionDir]
      : [path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions"), path.join(options.cwd, CONFIG_DIR_NAME, "sessions")]);
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
