import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { resolveAgentModel } from "./model-resolution.ts";
import type { SessionAgentManager } from "./session-agents.ts";

const PROTOCOL_VERSION = 2;

export function registerSubagentRpc(pi: ExtensionAPI, managerFor: (ctx: ExtensionContext) => { manager: SessionAgentManager; trusted: boolean; root: string }): () => void {
  const subscriptions: Array<() => void> = [];
  let currentCtx: ExtensionContext | undefined;
  const reply = (channel: string, requestId: unknown, value: unknown) => pi.events.emit(`${channel}:reply:${String(requestId ?? "")}`, value);
  subscriptions.push(pi.events.on("subagents:rpc:ping", (request: any) => reply("subagents:rpc:ping", request.requestId, { success: true, data: { version: PROTOCOL_VERSION } })));
  subscriptions.push(pi.events.on("subagents:rpc:spawn", (request: any) => {
    if (!currentCtx) return reply("subagents:rpc:spawn", request.requestId, { success: false, error: "No active session" });
    try {
      const { manager, trusted, root } = managerFor(currentCtx);
      const agent = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root }).find((item) => item.name.toLowerCase() === String(request.type).toLowerCase());
      if (!agent) throw new Error(`Unknown agent type: ${request.type}`);
      const persistent = agent.persistSession ?? false;
      const record = manager.spawn(agent, request.prompt, request.options?.description ?? request.type, root, {
        model: resolveAgentModel(agent.model ?? (typeof request.options?.model === "string" ? request.options.model : undefined), currentCtx.modelRegistry),
        thinking: agent.thinking ?? request.options?.thinking,
        maxTurns: agent.maxTurns ?? request.options?.max_turns,
        persistent,
        transcript: agent.outputTranscript,
        worktree: agent.isolation === "worktree" || request.options?.isolation === "worktree",
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
