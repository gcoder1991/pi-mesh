import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentDefinition, type AgentScope } from "./agents.ts";
import { registerCompatibilityTools } from "./compat-extension.ts";
import { FleetView } from "./fleet-view.ts";
import { sessionFleetLimiter } from "./fleet-limiter.ts";
import { MeshManager, type MeshRun, type MeshTask } from "./manager.ts";
import { loadMeshSettings, type MeshSettings } from "./settings.ts";
import { ackMessage, growthProposals, messages, pruneMeshState, putGrowth, putMessage, runFile, type ControlMessage, type GrowthProposal } from "./store.ts";
import { resolveAgentModel } from "./model-resolution.ts";
import { CompletionNotifier } from "./notifications.ts";
import { MeshTaskSchema } from "./schemas.ts";


const MeshParams = Type.Object({
  action: StringEnum(["list_agents", "run", "status", "list", "cancel", "pause", "resume", "retry_failed", "recover", "steer", "handoff_list", "message_send", "message_broadcast", "message_inbox", "message_ack", "growth_list", "growth_decide"] as const),
  scope: Type.Optional(StringEnum(["bundled", "user", "project", "all"] as const)),
  tasks: Type.Optional(Type.Array(MeshTaskSchema, { minItems: 1, maxItems: 32 })),
  runId: Type.Optional(Type.String({ description: "Existing run ID; required for run-scoped actions." })),
  nodeId: Type.Optional(Type.String({ description: "Node ID for node cancellation, inbox filtering, or message acknowledgement." })),
  messageId: Type.Optional(Type.String({ description: "Mailbox message ID required by message_ack." })),
  to: Type.Optional(Type.String({ description: "Recipient node ID required by message_send." })),
  from: Type.Optional(Type.String({ description: "Optional sender identity for host mailbox actions; defaults to host." })),
  content: Type.Optional(Type.String({ description: "Mailbox content, or steering message for steer." })),
  proposalId: Type.Optional(Type.String({ description: "Growth proposal ID required by growth_decide." })),
  decision: Type.Optional(StringEnum(["approve", "deny"] as const, { description: "Host decision for growth_decide." })), 
  async: Type.Optional(Type.Boolean()), operator: Type.Optional(StringEnum(["graph", "sequence", "parallel", "race", "supervisor", "mixture", "reflection", "debate"] as const)),
  worktree: Type.Optional(Type.Boolean()), worktreeSetupHook: Type.Optional(Type.String()),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "Per-run concurrency capped by mesh settings." })),
  maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Per-run node cap bounded by mesh settings." })),
  failFast: Type.Optional(Type.Boolean({ description: "Cancel remaining work after the first failed node." })),
}, { additionalProperties: false });

interface MeshDetails { action: string; [key: string]: unknown }
const terminalNodeStatuses = new Set(["succeeded", "failed", "cancelled", "skipped"]);
function resolveTaskModels(tasks: MeshTask[], registry: Parameters<typeof resolveAgentModel>[1], inheritedModel: string | undefined, resolveAgent: (name: string) => AgentDefinition | undefined): MeshTask[] {
  return tasks.map((task) => {
    const model = [task.model, resolveAgent(task.agent)?.model, inheritedModel].find((value) => value?.trim());
    return { ...task, model: resolveAgentModel(model, registry) };
  });
}
function runCounts(run: MeshRun): Record<string, number> {
  return run.nodes.reduce<Record<string, number>>((counts, node) => { counts[node.status] = (counts[node.status] ?? 0) + 1; return counts; }, {});
}
function growthReceipt(proposal: GrowthProposal<MeshTask[]>, run: MeshRun): Record<string, unknown> {
  const nodeIds = proposal.committedNodeIds ?? [];
  const nodes = nodeIds.map((id) => run.nodes.find((node) => node.id === id)).filter((node): node is MeshRun["nodes"][number] => Boolean(node));
  return { ...proposal, counts: nodes.reduce<Record<string, number>>((counts, node) => { counts[node.status] = (counts[node.status] ?? 0) + 1; return counts; }, {}),
    nodes: nodes.map((node) => ({ id: node.id, status: node.status, attempt: node.attempt, error: node.error, outputPath: node.outputPath, attemptResultPath: node.attemptResultPath, diagnosticPath: node.diagnosticPath })) };
}
function compactRun(run: MeshRun, includeNodes = false): Record<string, unknown> {
  return { id: run.id, status: run.status, revision: run.revision, cwd: run.cwd, operator: run.operator, counts: runCounts(run), nodeCount: run.nodes.length, checkpointPath: runFile(run.cwd, run.id), finishedAt: run.finishedAt,
    ...(includeNodes ? { nodes: run.nodes.map((node) => ({ id: node.id, agent: node.agent, status: node.status, attempt: node.attempt, outputPath: node.outputPath, outputBytes: node.outputBytes, outputTruncated: node.outputTruncated, attemptResultPath: node.attemptResultPath, diagnosticPath: node.diagnosticPath, error: node.error, worktree: node.worktree ? { path: node.worktree.path, baseCommit: node.worktree.baseCommit, finalCommit: node.worktree.finalCommit, branch: node.worktree.branch, patchPath: node.worktree.patchPath, handoffPath: node.worktree.handoffPath, filesChanged: node.worktree.filesChanged, cleanupStatus: node.worktree.cleanupStatus } : undefined })) } : {}) };
}
function boundedDetails<T>(value: T): T | { truncated: true; bytes: number; reference?: string } {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") <= DEFAULT_MAX_BYTES ? value : { truncated: true, bytes: Buffer.byteLength(json, "utf8"), reference: typeof value === "object" && value && "checkpointPath" in value ? String((value as Record<string, unknown>).checkpointPath) : undefined };
}
function boundedText(text: string, fullPath?: string): string {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return result.truncated ? `${result.content}\n\n[Output truncated.${fullPath ? ` Full data: ${fullPath}` : ""}]` : result.content;
}
function piUsage(run: MeshRun) {
  const totals = run.nodes.reduce((sum, node) => {
    const usage = node.usage;
    if (!usage) return sum;
    sum.input += usage.input; sum.output += usage.output; sum.cacheRead += usage.cacheRead; sum.cacheWrite += usage.cacheWrite;
    sum.costInput += usage.costInput ?? 0; sum.costOutput += usage.costOutput ?? 0; sum.costCacheRead += usage.costCacheRead ?? 0; sum.costCacheWrite += usage.costCacheWrite ?? 0; sum.costTotal += usage.cost;
    return sum;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0 });
  return { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
    cost: { input: totals.costInput, output: totals.costOutput, cacheRead: totals.costCacheRead, cacheWrite: totals.costCacheWrite, total: totals.costTotal } };
}
function summarize(run: MeshRun): string {
  const text = [`Mesh ${run.id}: ${run.status} r${run.revision}`, ...run.nodes.map((node) => `\n### ${node.id} · ${node.agent} · ${node.status}${node.error ? ` — ${node.error}${node.attemptResultPath ? `\nResult: ${node.attemptResultPath}` : ""}${node.diagnosticPath ? `\nExplanation: ${node.diagnosticPath}` : ""}` : node.output ? `\n${node.output}` : ""}`)].join("\n");
  return boundedText(text, runFile(run.cwd, run.id));
}

export default function registerPiMesh(pi: ExtensionAPI): void {
  if (process.env.PI_MESH_CHILD === "1") return;
  const managers = new Map<string, { manager: MeshManager; settings: MeshSettings; notifier: CompletionNotifier; resolveAgent: (name: string) => AgentDefinition | undefined }>();
  const currentManager = (cwd: string, projectTrusted: boolean, sessionId: string, modelRegistry: Parameters<typeof resolveAgentModel>[1]) => {
    const root = fs.realpathSync(path.resolve(cwd));
    const key = `${root}\0${projectTrusted}\0${sessionId}`;
    const existing = managers.get(key);
    if (existing) return existing;
    const settings = loadMeshSettings(root, process.env, projectTrusted);
    pruneMeshState(root, settings);
    const limiter = sessionFleetLimiter(sessionId, settings.maxConcurrentAgents);
    const resolveAgent = (name: string) => discoverAgents(root, { scope: "all", includeProject: projectTrusted, projectRoot: root }).find((agent) => agent.name === name);
    const manager = new MeshManager(resolveAgent, settings, limiter, modelRegistry);
    manager.recover(root);
    const entry = { manager, settings, notifier: new CompletionNotifier(pi, settings), resolveAgent };
    managers.set(key, entry);
    return entry;
  };
  const fleet = new FleetView();
  pi.registerTool({
    name: "mesh", label: "Mesh",
    description: "Host-owned persistent child-agent mesh for complex, parallel, or broad work, with dynamically discovered specialized agents, dependency graphs, optional Git worktree isolation, retries, recovery, mailbox, and host-approved growth.",
    promptSnippet: "Launch and coordinate specialized sub-agents for complex, parallel, or broad work",
    promptGuidelines: [
      "Before the first mesh run in a project, or whenever agent selection is uncertain, call mesh with action list_agents and choose from the returned bundled, user, and project agents. Treat each description as the agent's routing contract; do not infer capabilities from its name alone.",
      "Use mesh when work has independent branches, needs specialized review, or broad exploration would flood the main context. Use direct read, grep, and find tools when the target is already known and narrow.",
      "Do not duplicate work already delegated to mesh nodes. Consume their bounded evidence and synthesize the results.",
      "If a run partially fails, call retry_failed on that run instead of creating replacement IDs or resubmitting successful nodes.",
      "In mesh, only the host approves growth. Enable mesh worktree mode for parallel writers; it requires a clean Git checkout. Use mesh recover after reopening a project to restart interrupted runs.",
    ],
    parameters: MeshParams,
    renderCall(args, theme) {
      const target = args.runId ? ` ${args.runId.slice(0, 8)}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("mesh"))} ${theme.fg("muted", args.action)}${target}`, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", result.content[0]?.type === "text" ? result.content[0].text : "Mesh running…"), 0, 0);
      const details = result.details as MeshDetails | undefined;
      const run = details?.run as Record<string, unknown> | undefined;
      const status = typeof run?.status === "string" ? run.status : undefined;
      const rawTitle = status ? `${status} · ${run?.nodeCount ?? "?"} nodes` : result.content[0]?.type === "text" ? result.content[0].text.split("\n", 1)[0] : "Done";
      const title = rawTitle.length > 160 ? `${rawTitle.slice(0, 157)}…` : rawTitle;
      let text = theme.fg(status === "succeeded" ? "success" : status === "failed" || status === "cancelled" ? "error" : "accent", title);
      if (expanded && result.content[0]?.type === "text") text += `\n${theme.fg("dim", result.content[0].text)}`;
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const projectTrusted = ctx.isProjectTrusted?.() ?? false;
      const sessionId = ctx.sessionManager.getSessionId();
      const { manager, settings, notifier, resolveAgent } = currentManager(ctx.cwd, projectTrusted, sessionId, ctx.modelRegistry);
      const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      if (ctx.mode === "tui") fleet.bindMesh(ctx, manager, `${fs.realpathSync(path.resolve(ctx.cwd))}\0${projectTrusted}\0${sessionId}`);
      const requestedScope: AgentScope = params.scope ?? "all";
      const scope: AgentScope = !projectTrusted && requestedScope === "project" ? "project" : requestedScope;
      if (params.action === "list_agents") {
        const root = fs.realpathSync(path.resolve(ctx.cwd));
        const agents = discoverAgents(root, { scope, includeProject: projectTrusted, projectRoot: root }).map(({ name, description, source, tools, model }) => ({ name, description, source, tools, model }));
        const text = agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n") || "No agents found.";
        return { content: [{ type: "text", text: boundedText(text) }], details: boundedDetails({ action: params.action, count: agents.length, agents }) };
      }
      if (params.action === "list") {
        const runs = manager.list();
        const text = runs.map((run) => `${run.id} ${run.status} (${run.nodes.length} nodes)`).join("\n") || "No mesh runs.";
        return { content: [{ type: "text", text: boundedText(text) }], details: boundedDetails({ action: params.action, count: runs.length, runs: runs.map((item) => compactRun(item)) }) };
      }
      if (params.action === "recover") {
        const resumed: string[] = [];
        for (const run of manager.list()) if (run.status === "running") { void manager.resumeRecovered(run.id); resumed.push(run.id); }
        return { content: [{ type: "text", text: resumed.length ? `Resumed: ${resumed.join(", ")}` : "No interrupted runs." }], details: boundedDetails({ action: params.action, resumed }) };
      }
      if (!params.runId && params.action !== "run") throw new Error("runId is required");
      const run = params.runId ? manager.get(params.runId) : undefined;
      if (params.runId && !run) throw new Error(`Unknown mesh run: ${params.runId}`);

      if (params.action === "status") return { content: [{ type: "text", text: summarize(run!) }], details: boundedDetails({ action: params.action, run: compactRun(run!, true) }) };
      if (params.action === "handoff_list") {
        const handoffs = run!.nodes.flatMap((node) => (node.worktreeHistory ?? (node.worktree ? [node.worktree] : [])).filter((state) => state.finalCommit).map((state) => ({
          nodeId: node.id, attempt: state.attempt, branch: state.branch, commit: state.finalCommit, patchPath: state.patchPath, handoffPath: state.handoffPath,
        })));
        const text = handoffs.map((item) => `${item.nodeId} attempt ${item.attempt}\n  branch: ${item.branch}\n  commit: ${item.commit}\n  integrate: git cherry-pick ${item.commit}\n  patch: ${item.patchPath ?? "none"}`).join("\n") || "No handoffs.";
        return { content: [{ type: "text", text: boundedText(text, runFile(run!.cwd, run!.id)) }], details: boundedDetails({ action: params.action, count: handoffs.length, handoffs: handoffs.slice(0, 256) }) };
      }
      if (params.action === "cancel") {
        if (!manager.cancel(params.runId!, params.nodeId)) throw new Error("Run/node is not cancellable");
        return { content: [{ type: "text", text: `Cancelled ${params.nodeId ?? params.runId}.` }], details: boundedDetails({ action: params.action, run: compactRun(run!) }) };
      }
      if (params.action === "pause") {
        if (!manager.pause(params.runId!)) throw new Error("Run is not pausable");
        return { content: [{ type: "text", text: `Paused ${params.runId}. Running children finish; queued children wait.` }], details: boundedDetails({ action: params.action, run: compactRun(run!) }) };
      }
      if (params.action === "retry_failed") {
        const update = (value: MeshRun) => onUpdate?.({ content: [{ type: "text", text: `${value.nodes.filter((node) => terminalNodeStatuses.has(node.status)).length}/${value.nodes.length} complete` }], details: boundedDetails({ action: params.action, run: compactRun(value) }) });
        const completed = await manager.retryFailed(params.runId!, signal, update);
        return { content: [{ type: "text", text: summarize(completed) }], details: boundedDetails({ action: params.action, run: compactRun(completed, true) }), usage: piUsage(completed) };
      }
      if (params.action === "resume") {
        const resumed = manager.resume(params.runId!); void resumed.catch(() => {});
        return { content: [{ type: "text", text: `Resumed ${params.runId}.` }], details: boundedDetails({ action: params.action, run: compactRun(run!) }) };
      }
      if (params.action === "steer") {
        if (!params.nodeId || !params.content?.trim() || !manager.steer(params.runId!, params.nodeId, params.content.trim())) throw new Error("runId, running nodeId, and content are required for steer");
        return { content: [{ type: "text", text: `Steered ${params.runId}/${params.nodeId}.` }], details: { action: params.action, runId: params.runId, nodeId: params.nodeId } };
      }
      if (params.action.startsWith("message_")) {
        if (params.action === "message_inbox") {
          const inbox = messages(run!.cwd, run!.id).filter((message) => (!params.nodeId || message.to === params.nodeId) && !message.ackedAt);
          const text = boundedText(JSON.stringify(inbox), runFile(run!.cwd, run!.id));
          return { content: [{ type: "text", text }], details: boundedDetails({ action: params.action, count: inbox.length, inbox: inbox.slice(0, 256) }) };
        }
        if (params.action === "message_ack") {
          if (!params.messageId || !params.nodeId || !ackMessage(run!.cwd, run!.id, params.messageId, params.nodeId)) throw new Error("messageId/nodeId does not identify an unacked delivery");
          return { content: [{ type: "text", text: `Acknowledged ${params.messageId}.` }], details: { action: params.action } };
        }
        if (!params.content?.trim()) throw new Error("content is required");
        const recipients = params.action === "message_broadcast" ? run!.nodes.map((node) => node.id).filter((id) => id !== (params.from ?? "host")) : [params.to ?? ""];
        if (recipients.some((id) => !run!.nodes.some((node) => node.id === id))) throw new Error("Unknown recipient node");
        const sent: ControlMessage[] = recipients.map((to) => ({ id: crypto.randomUUID(), runId: run!.id, from: params.from ?? "host", to, content: params.content!.trim(), createdAt: Date.now() }));
        for (const message of sent) putMessage(run!.cwd, message, { payloadMaxBytes: settings.messagePayloadMaxBytes, recipientUnreadMaxBytes: settings.recipientUnreadMaxBytes });
        return { content: [{ type: "text", text: `Queued ${sent.length} message(s).` }], details: boundedDetails({ action: params.action, messages: sent }) };
      }
      if (params.action === "growth_list") {
        const proposals = growthProposals<MeshTask[]>(run!.cwd, run!.id).map((proposal) => growthReceipt(proposal, run!));
        return { content: [{ type: "text", text: boundedText(JSON.stringify(proposals), runFile(run!.cwd, run!.id)) }], details: boundedDetails({ action: params.action, count: proposals.length, proposals: proposals.slice(0, 256) }) };
      }
      if (params.action === "growth_decide") {
        if (!params.proposalId || !params.decision) throw new Error("proposalId and decision are required");
        const proposal = growthProposals<MeshTask[]>(run!.cwd, run!.id).find((item) => item.id === params.proposalId);
        if (!proposal || proposal.status !== "proposed") throw new Error("Growth proposal is not pending");
        const requester = run!.nodes.find((node) => node.id === proposal.requester);
        if (!requester || !["running", "paused"].includes(requester.status) || requester.attempt !== proposal.requesterAttempt || run!.revision !== proposal.baseRevision) throw new Error("Growth proposal requester/revision is stale");
        if (requester.allowedSubagents !== "all") {
          const allowed = new Set((requester.allowedSubagents ?? []).map((name) => name.toLowerCase()));
          const denied = proposal.tasks.map((task) => task.agent).filter((name) => !allowed.has(name.toLowerCase()));
          if (denied.length) throw new Error(`Growth proposal requests unauthorized agents: ${[...new Set(denied)].join(", ")}`);
        }
        if (params.decision === "approve") {
          try {
            proposal.tasks = resolveTaskModels(proposal.tasks, ctx.modelRegistry, inheritedModel, resolveAgent);
            proposal.committedNodeIds = manager.grow(run!.id, proposal.requester, proposal.tasks).map((node) => node.id);
            proposal.status = "committed";
          } catch (error) { proposal.status = "denied"; proposal.error = error instanceof Error ? error.message : String(error); }
        } else proposal.status = "denied";
        proposal.decidedAt = Date.now(); putGrowth(run!.cwd, proposal as GrowthProposal<MeshTask[]>);
        return { content: [{ type: "text", text: `Growth ${proposal.status}: ${proposal.id}.` }], details: boundedDetails({ action: params.action, proposal: growthReceipt(proposal, run!), run: compactRun(run!) }) };
      }

      if (!params.tasks?.length) throw new Error("tasks is required for run");
      const update = (value: MeshRun) => onUpdate?.({ content: [{ type: "text", text: `${value.nodes.filter((node) => terminalNodeStatuses.has(node.status)).length}/${value.nodes.length} complete` }], details: boundedDetails({ action: params.action, run: compactRun(value) }) });
      if (signal?.aborted) throw new Error("Mesh run cancelled before creation");
      const createdRun = manager.create({ tasks: resolveTaskModels(params.tasks as MeshTask[], ctx.modelRegistry, inheritedModel, resolveAgent), cwd: fs.realpathSync(path.resolve(ctx.cwd)), operator: params.operator, worktree: params.worktree, worktreeSetupHook: params.worktreeSetupHook, maxConcurrency: params.maxConcurrency, maxNodes: params.maxNodes, failFast: params.failFast });
      const start = manager.startCreated(createdRun.id, params.async ? undefined : signal, params.async ? undefined : update);
      if (params.async) {
        void start.then((completed) => notifier.enqueueMessage(`mesh:${completed.id}`, `Mesh ${completed.id} finished: ${completed.status}.\n${summarize(completed)}`), (error) => notifier.enqueueMessage(`mesh:${createdRun.id}`, `Mesh ${createdRun.id} failed outside the run state: ${error instanceof Error ? error.message : String(error)}`));
        return { content: [{ type: "text", text: `Started mesh ${createdRun.id}. You will be notified when it completes.` }], details: boundedDetails({ action: params.action, run: compactRun(createdRun) }) };
      }
      const completed = await start;
      return { content: [{ type: "text", text: summarize(completed) }], details: boundedDetails({ action: params.action, run: compactRun(completed, true) }), usage: piUsage(completed) };
    },
  });

  pi.registerCommand("mesh", {
    description: "Force the next task through pi-mesh orchestration",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) { ctx.ui.notify("Usage: /mesh <task>", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy; wait for the current turn before starting /mesh.", "warning"); return; }
      pi.sendUserMessage(`You must execute this request through the mesh tool. Do not solve it directly and do not use the standalone Agent tool. First call mesh with action \"list_agents\", then create and run an appropriate mesh DAG for this task in the foreground (omit async or set async=false). The foreground mesh call already waits and streams progress; do not poll with mesh status/list and do not steer unless the user explicitly asks. After it returns, inspect node evidence and synthesize the final answer.\n\nTask:\n${task}`);
    },
  });
  const shutdownSubagents = registerCompatibilityTools(pi, fleet);
  pi.on("session_shutdown", async () => { await Promise.allSettled([...managers.values()].map(({ manager }) => manager.shutdown())); for (const { notifier } of managers.values()) notifier.dispose(); managers.clear(); await shutdownSubagents(); });
}
