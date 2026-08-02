import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import type { SessionAgentManager } from "./session-agents.ts";

export function registerSubagentRpc(pi: ExtensionAPI, managerFor: (ctx: ExtensionContext) => { manager: SessionAgentManager; trusted: boolean; root: string }): () => void {
  const subscriptions: Array<() => void> = [];
  subscriptions.push(pi.events.on("subagents:rpc:ping", (request: any) => pi.events.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 1 } })));
  subscriptions.push(pi.events.on("subagents:rpc:spawn", (request: any) => {
    const ctx = request.ctx as ExtensionContext | undefined;
    if (!ctx) return pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "RPC spawn requires ctx" });
    try {
      const { manager, trusted, root } = managerFor(ctx);
      const agent = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root }).find((item) => item.name.toLowerCase() === String(request.type).toLowerCase());
      if (!agent) throw new Error(`Unknown agent type: ${request.type}`);
      const record = manager.spawn(agent, request.prompt, request.options?.description ?? request.type, root, { model: typeof request.options?.model === "string" ? request.options.model : undefined, thinking: request.options?.thinking, maxTurns: request.options?.max_turns, worktree: request.options?.isolation === "worktree" });
      pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: record.id } });
    } catch (error) { pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: error instanceof Error ? error.message : String(error) }); }
  }));
  subscriptions.push(pi.events.on("subagents:rpc:stop", (request: any) => {
    const ctx = request.ctx as ExtensionContext | undefined;
    if (!ctx) return pi.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, { success: false, error: "RPC stop requires ctx" });
    const ok = managerFor(ctx).manager.abort(request.agentId);
    pi.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, ok ? { success: true } : { success: false, error: "Agent is not running" });
  }));
  pi.events.emit("subagents:ready", { version: 1, nonce: crypto.randomUUID() });
  return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
}
