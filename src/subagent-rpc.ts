import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { resolveAgentModel } from "./model-resolution.ts";
import type { SessionAgentManager } from "./session-agents.ts";

const PROTOCOL_VERSION = 2;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function spawnOptions(value: unknown): any {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid spawn options");
  const options = value as Record<string, unknown>;
  const allowed = new Set(["description", "model", "thinking", "max_turns", "isolation"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("Invalid spawn options");
  if (options.description !== undefined && typeof options.description !== "string") throw new Error("description must be a string");
  if (options.model !== undefined && typeof options.model !== "string") throw new Error("model must be a string");
  if (options.thinking !== undefined && (typeof options.thinking !== "string" || !THINKING_LEVELS.has(options.thinking))) throw new Error("Invalid thinking level");
  if (options.max_turns !== undefined && (!Number.isInteger(options.max_turns) || Number(options.max_turns) < 1 || Number(options.max_turns) > 1000)) throw new Error("max_turns must be an integer from 1 to 1000");
  if (options.isolation !== undefined && options.isolation !== "worktree") throw new Error("isolation must be worktree");
  return options;
}

export function registerSubagentRpc(pi: ExtensionAPI, managerFor: (ctx: ExtensionContext) => { manager: SessionAgentManager; trusted: boolean; root: string }): () => void {
  const subscriptions: Array<() => void> = [];
  let currentCtx: ExtensionContext | undefined;
  const reply = (channel: string, requestId: unknown, value: unknown) => pi.events.emit(`${channel}:reply:${String(requestId ?? "")}`, value);
  subscriptions.push(pi.events.on("subagents:rpc:ping", (request: any) => reply("subagents:rpc:ping", request.requestId, { success: true, data: { version: PROTOCOL_VERSION } })));
  subscriptions.push(pi.events.on("subagents:rpc:spawn", (request: any) => {
    if (!currentCtx) return reply("subagents:rpc:spawn", request.requestId, { success: false, error: "No active session" });
    try {
      const { manager, trusted, root } = managerFor(currentCtx);
      if (typeof request?.type !== "string" || typeof request?.prompt !== "string" || !request.prompt.trim()) throw new Error("type and prompt are required");
      const options = spawnOptions(request.options);
      const agent = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root }).find((item) => item.name.toLowerCase() === request.type.toLowerCase());
      if (!agent) throw new Error(`Unknown agent type: ${request.type}`);
      const persistent = agent.persistSession ?? false;
      const record = manager.spawn(agent, request.prompt, options.description ?? request.type, root, {
        model: resolveAgentModel(agent.model ?? options.model, currentCtx.modelRegistry),
        thinking: agent.thinking ?? options.thinking,
        maxTurns: agent.maxTurns ?? options.max_turns,
        persistent,
        transcript: agent.outputTranscript,
        worktree: options.isolation === "worktree" || agent.isolation === "worktree",
        sessionDir: persistent ? currentCtx.sessionManager.getSessionDir() : undefined,
      });
      reply("subagents:rpc:spawn", request.requestId, { success: true, data: { id: record.id } });
    } catch (error) { reply("subagents:rpc:spawn", request.requestId, { success: false, error: error instanceof Error ? error.message : String(error) }); }
  }));
  subscriptions.push(pi.events.on("subagents:rpc:stop", (request: any) => {
    if (!currentCtx) return reply("subagents:rpc:stop", request.requestId, { success: false, error: "No active session" });
    const ok = managerFor(currentCtx).manager.abort(request.agentId);
    reply("subagents:rpc:stop", request.requestId, ok ? { success: true } : { success: false, error: "Agent is not running" });
  }));
  pi.on("session_start", (_event, ctx) => { currentCtx = ctx; pi.events.emit("subagents:ready", { version: PROTOCOL_VERSION, nonce: crypto.randomUUID() }); });
  pi.on("session_shutdown", () => { currentCtx = undefined; });
  return () => { currentCtx = undefined; for (const unsubscribe of subscriptions) unsubscribe(); };
}
