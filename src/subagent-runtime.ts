import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";
import { buildChildArgs, resolveChildExtensions, resolveChildSkills, type ChildResult } from "./pi-process.ts";
import { createRpcChild, type RpcChildSession } from "./rpc-child.ts";
import type { MeshSettings } from "./settings.ts";
import { memoryPrompt } from "./memory.ts";

export interface SubagentRunOptions {
  id: string;
  cwd: string;
  sessionDir?: string;
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
}

export interface SubagentSession {
  id: string;
  session: RpcChildSession;
  steer(message: string): void;
  abort(): void;
  close(): Promise<void>;
  conversation(): string;
}

export interface SubagentExecution extends SubagentSession {
  completion: Promise<ChildResult>;
}

export class SubagentRuntime {
  private readonly settings: MeshSettings;
  constructor(settings: MeshSettings) { this.settings = settings; this.validateResourcePaths(); }

  private connectInternal(agent: AgentDefinition, options: SubagentRunOptions): { connection: SubagentSession; prompt: string } {
    const selectedExtensions = agent.isolated ? [] : agent.extensions ?? [];
    const selectedSkills = agent.isolated ? [] : agent.skills ?? [];
    const missingExtensions = selectedExtensions.filter((name) => !this.settings.childExtensions[name]);
    const missingSkills = selectedSkills.filter((name) => !this.settings.childSkills[name]);
    if (missingExtensions.length || missingSkills.length) throw new Error(`Unapproved child resources: ${[...missingExtensions.map((name) => `extension:${name}`), ...missingSkills.map((name) => `skill:${name}`)].join(", ")}`);

    const configured = { ...agent, extensions: selectedExtensions, skills: selectedSkills, model: options.model ?? agent.model, thinking: options.thinking ?? agent.thinking };
    if (configured.extensions?.some((name) => ["pi-mesh", "pi-subagents", "subagents"].includes(name.toLowerCase()))) throw new Error("Agent-management extensions cannot be loaded inside a child");
    const sessionDir = options.persistent || agent.persistSession ? options.sessionDir ?? path.join(options.cwd, CONFIG_DIR_NAME, "mesh", "sessions") : undefined;
    const transcriptPath = options.transcript === false || agent.outputTranscript === false ? undefined : options.transcriptPath ?? path.join(os.tmpdir(), "pi-mesh-subagents", options.id, "conversation.jsonl");
    const built = buildChildArgs(configured, options.prompt, configured.model, {
      extensions: [
        ...resolveChildExtensions(configured, this.settings.childExtensions),
      ],
      skills: resolveChildSkills(configured, this.settings.childSkills),
      sessionDir,
      sessionId: sessionDir ? options.id : undefined,
      meshControl: Boolean(options.env?.PI_MESH_RUN_ID),
    });
    const args: string[] = [];
    for (let index = 0; index < built.args.length; index++) {
      const value = built.args[index]!;
      if (value === "--mode") { index++; continue; }
      if (["json", "--print", "--no-session"].includes(value)) continue;
      if (value.startsWith("Task: ")) continue;
      args.push(value);
    }
    const session = createRpcChild(configured, options.cwd, { args, env: options.env, transcriptPath, maxTurns: options.maxTurns ?? agent.maxTurns, onEvent: options.onEvent });
    const inherited = options.parentContext ? `\n\n## Parent conversation context\n${Buffer.from(options.parentContext).subarray(-128 * 1024).toString("utf8")}` : "";
    const prompt = `Task: ${options.prompt}${inherited}${memoryPrompt(configured, options.cwd)}`;
    const connection: SubagentSession = {
      id: options.id,
      session,
      steer: (message) => session.steer(message),
      abort: () => session.abort(),
      close: async () => { try { await session.close(); } finally { built.cleanup(); } },
      conversation: () => session.conversation(),
    };
    return { connection, prompt };
  }

  connect(agent: AgentDefinition, options: SubagentRunOptions): SubagentSession {
    return this.connectInternal(agent, options).connection;
  }

  start(agent: AgentDefinition, options: SubagentRunOptions): SubagentExecution {
    const { connection, prompt } = this.connectInternal(agent, options);
    return { ...connection, completion: connection.session.prompt(prompt) };
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
