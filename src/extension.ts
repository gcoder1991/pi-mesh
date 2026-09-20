import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentDefinition, type AgentScope } from "./agents.ts";
import { registerHostBridge, managedBridgeChild } from "./host-bridge.ts";
import { registerCompatibilityTools } from "./compat-extension.ts";
import { FleetView } from "./fleet-view.ts";
import { openMeshTree } from "./mesh-tree.ts";
import { retainSessionFleetLimiter, sessionFleetLimiter } from "./fleet-limiter.ts";
import { MeshManager, type MeshRun, type MeshTask } from "./manager.ts";
import { loadMeshSettings, type MeshSettings } from "./settings.ts";
import { ackMessage, growthProposals, messages, pruneMeshState, storeMessages, messageReceiptDetails, runFile, type ControlMessage, type GrowthProposal } from "./store.ts";
import { resolveAgentModel } from "./model-resolution.ts";
import { CompletionNotifier } from "./notifications.ts";
import { buildConsensusPrompt } from "./consensus-template.ts";
import { MeshTaskSchema } from "./schemas.ts";
import { discoverWorkflowFiles, instantiateWorkflow, parseWorkflowInputs, type MeshWorkflow } from "./workflows.ts";

import { ContinuationTaskSchema, continuationTasks, requestContinuation, successfulEpoch, type ContinuationPermit } from "./continuation.ts";

const MeshParams = Type.Object({
  action: StringEnum(["list_agents", "run", "continue", "status", "list", "cancel", "pause", "resume", "retry_failed", "recover", "steer", "handoff_list", "message_send", "message_broadcast", "message_inbox", "message_ack", "growth_list", "growth_decide", "bridge_send", "bridge_inbox", "bridge_status", "bridge_ack"] as const),
  routeId: Type.Optional(Type.String({ maxLength: 64 })),
  forwardInboxId: Type.Optional(Type.String({ maxLength: 128 })),
  scope: Type.Optional(StringEnum(["bundled", "user", "project", "all"] as const)),
  tasks: Type.Optional(Type.Array(MeshTaskSchema, { minItems: 1, maxItems: 32 })),
  continuationTasks: Type.Optional(Type.Array(ContinuationTaskSchema, { minItems: 1, maxItems: 4, description: "Optional fixed next-stage tasks authorized with this initial background run. On successful first-epoch completion, mesh continue may create this exact plan once within one hour. Sequential, max 10min/task, no retries or recursive continuation. Do not use for unplanned remediation." })),
  runId: Type.Optional(Type.String({ description: "Existing run ID; required for run-scoped actions." })),
  nodeId: Type.Optional(Type.String({ description: "Node ID for node cancellation, inbox filtering, or message acknowledgement." })),
  messageId: Type.Optional(Type.String({ description: "Mailbox message ID required by message_ack." })),
  to: Type.Optional(Type.String({ description: "Recipient node ID required by message_send." })),
  from: Type.Optional(Type.String({ description: "Optional display label for Host-relayed messages; never child authorization." })),
  content: Type.Optional(Type.String({ description: "Mailbox content, or steering message for steer." })),
  proposalId: Type.Optional(Type.String({ description: "Growth proposal ID required by growth_decide." })),
  decision: Type.Optional(StringEnum(["approve", "deny"] as const, { description: "Host decision for growth_decide." })), 
  async: Type.Optional(Type.Boolean({ description: "Run in background and wake the Host on completion. Defaults to true; set false only when blocking is explicitly required." })), operator: Type.Optional(StringEnum(["graph", "sequence", "parallel", "race", "supervisor", "mixture", "reflection", "debate"] as const)),
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
  return { id: run.id, status: run.status, revision: run.revision, cwd: run.cwd, operator: run.operator, cancelSource: run.cancelSource, autoContinueBlocked: run.autoContinueBlocked, counts: runCounts(run), nodeCount: run.nodes.length, checkpointPath: runFile(run.cwd, run.id), finishedAt: run.finishedAt,
    ...(includeNodes ? { nodes: run.nodes.map((node) => ({ id: node.id, agent: node.agent, status: node.status, attempt: node.attempt, outputPath: node.outputPath, outputBytes: node.outputBytes, outputTruncated: node.outputTruncated, attemptResultPath: node.attemptResultPath, diagnosticPath: node.diagnosticPath, evidencePath: node.evidencePath, error: node.error, worktree: node.worktree ? { path: node.worktree.path, baseCommit: node.worktree.baseCommit, finalCommit: node.worktree.finalCommit, branch: node.worktree.branch, patchPath: node.worktree.patchPath, handoffPath: node.worktree.handoffPath, filesChanged: node.worktree.filesChanged, cleanupStatus: node.worktree.cleanupStatus, cleanupError: node.worktree.cleanupError, phase: node.worktree.phase, handoffBaseCommit: node.worktree.handoffBaseCommit } : undefined })) } : {}) };
}
function boundedDetails<T>(value: T): T | { truncated: true; bytes: number; reference?: string } {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") <= DEFAULT_MAX_BYTES ? value : { truncated: true, bytes: Buffer.byteLength(json, "utf8"), reference: typeof value === "object" && value && "checkpointPath" in value ? String((value as Record<string, unknown>).checkpointPath) : undefined };
}
function boundedText(text: string, fullPath?: string): string {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return result.truncated ? `${result.content}\n\n[Output truncated.${fullPath ? ` Full data: ${fullPath}` : ""}]` : result.content;
}
function piUsage(usage: import("./pi-process.ts").Usage | undefined) {
  if (!usage) return undefined;
  const totals = [usage].reduce((sum, usage) => {
    if (!usage) return sum;
    sum.input += usage.input; sum.output += usage.output; sum.cacheRead += usage.cacheRead; sum.cacheWrite += usage.cacheWrite;
    sum.costInput += usage.costInput ?? 0; sum.costOutput += usage.costOutput ?? 0; sum.costCacheRead += usage.costCacheRead ?? 0; sum.costCacheWrite += usage.costCacheWrite ?? 0; sum.costTotal += usage.cost;
    return sum;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0 });
  return { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
    cost: { input: totals.costInput, output: totals.costOutput, cacheRead: totals.costCacheRead, cacheWrite: totals.costCacheWrite, total: totals.costTotal } };
}
function summarize(run: MeshRun): string {
  const pending = growthProposals<MeshTask[]>(run.cwd, run.id).filter((proposal) => proposal.status === "proposed");
  const growth = pending.length ? `\n\nHost approval required for ${pending.length} growth proposal(s):\n${pending.map((proposal) => `- ${proposal.id} from ${proposal.requester}: ${proposal.reason}`).join("\n")}\nUse growth_list and growth_decide.` : "";
  const text = [`Mesh ${run.id}: ${run.status} r${run.revision}`, ...run.nodes.map((node) => `\n### ${node.id} · ${node.agent} · ${node.status}${node.error ? ` — ${node.error}${node.attemptResultPath ? `\nResult: ${node.attemptResultPath}` : ""}${node.diagnosticPath ? `\nExplanation: ${node.diagnosticPath}` : ""}` : node.output ? `\n${node.output}` : ""}`)].join("\n") + growth;
  return boundedText(text, runFile(run.cwd, run.id));
}

export default function registerPiMesh(pi: ExtensionAPI): void {
  if (managedBridgeChild(pi.events)) return;
  const plans = new Map<string, { tasks: MeshTask[]; permit: ContinuationPermit; epoch: number; sessionId: string; cwd: string; expires: number }>();
  pi.on("input", (event) => { if (event.source === "interactive" || event.source === "rpc") plans.clear(); });
  const managers = new Map<string, { manager: MeshManager; settings: MeshSettings; notifier: CompletionNotifier; releaseFleet: () => void; resolveAgent: (name: string) => AgentDefinition | undefined }>();
  const currentManager = (cwd: string, projectTrusted: boolean, sessionId: string, modelRegistry: Parameters<typeof resolveAgentModel>[1]) => {
    const root = fs.realpathSync(path.resolve(cwd));
    const key = `${root}\0${sessionId}`;
    const existing = managers.get(key);
    const settings = loadMeshSettings(root, process.env, projectTrusted);
    const resolveAgent = (name: string) => discoverAgents(root, { scope: "all", includeProject: projectTrusted, projectRoot: root }).find((agent) => agent.name === name);
    if (existing) {
      existing.manager.updateAuthorization(settings, projectTrusted, resolveAgent);
      existing.settings = settings; existing.resolveAgent = resolveAgent;
      return existing;
    }
    pruneMeshState(root, settings);
    const limiter = sessionFleetLimiter(sessionId, settings.maxConcurrentAgents);
    const manager = new MeshManager(resolveAgent, settings, limiter, modelRegistry, sessionId, projectTrusted);
    manager.recover(root);
    for (const diagnostic of manager.diagnostics) console.error(`[pi-mesh] ${diagnostic}`);
    const entry = { manager, settings, releaseFleet: retainSessionFleetLimiter(sessionId, limiter), notifier: new CompletionNotifier(pi, settings), resolveAgent };
    managers.set(key, entry);
    return entry;
  };
  const watchBackground = (pending: Promise<MeshRun>, notifier: CompletionNotifier, runId: string) => {
    const plan = plans.get(runId);
    void pending.then((run) => {
      if (!["succeeded", "failed", "cancelled"].includes(run.status)) return;
      const valid = () => plan && plans.get(run.id) === plan && Date.now() < plan.expires && successfulEpoch(run, plan.epoch);
      notifier.enqueueMessage(`mesh:${run.id}:${run.epoch ?? 0}:${run.nodes.map((node) => node.attempt).join(".")}`, `Mesh ${run.id} finished: ${run.status}.\n${summarize(run)}`, false, (details) => {
        if (valid() && plan!.permit.complete(details)) return `\nA fixed successor was predeclared by the original user turn. Use mesh action continue with runId ${run.id}; no extra parameters. This is not permission for arbitrary tasks.`;
      });
    }, (error) => notifier.enqueueMessage(`mesh:${runId}:error`, `Mesh ${runId} failed outside run state: ${String(error)}. Drain and recover explicitly.`)).catch((error) => console.error(`[pi-mesh] Completion notification failed: ${String(error)}`));
  };
  const fleet = new FleetView();
  const workflowNames = new Set<string>();
  const findWorkflow = (name: string, ctx: any): MeshWorkflow | undefined => {
    const root = fs.realpathSync(path.resolve(ctx.cwd));
    return discoverWorkflowFiles(root, process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir(), ctx.isProjectTrusted?.() ?? false).workflows.find((workflow) => workflow.name === name);
  };
  const runWorkflow = async (name: string, args: string, ctx: any): Promise<void> => {
    if (!ctx.isIdle()) return void ctx.ui.notify(`Agent is busy; wait before starting /${name}.`, "warning");
    try {
      const workflow = findWorkflow(name, ctx);
      if (!workflow) throw new Error(`Workflow is not available in the current project: ${name}`);
      const loaded = instantiateWorkflow(workflow, parseWorkflowInputs(args, workflow.promptInput));
      const root = fs.realpathSync(path.resolve(ctx.cwd));
      const trusted = ctx.isProjectTrusted?.() ?? false;
      const sessionId = ctx.sessionManager.getSessionId();
      const { manager, notifier, resolveAgent } = currentManager(root, trusted, sessionId, ctx.modelRegistry);
      const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const created = manager.create({ tasks: resolveTaskModels(loaded.tasks, ctx.modelRegistry, inheritedModel, resolveAgent), cwd: root, operator: loaded.operator, worktree: loaded.worktree, worktreeSetupHook: loaded.worktreeSetupHook, maxConcurrency: loaded.maxConcurrency, maxNodes: loaded.maxNodes, failFast: loaded.failFast });
      const started = manager.startCreated(created.id);
      if (loaded.async !== false) {
        watchBackground(started, notifier, created.id);
        ctx.ui.notify(`Started mesh ${created.id}.`, "info");
      } else {
        const completed = await started;
        ctx.ui.notify(`Mesh ${completed.id}: ${completed.status}.`, completed.status === "succeeded" ? "info" : "warning");
      }
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
  };
  const registerWorkflows = (cwd: string, trusted: boolean) => {
    const root = fs.realpathSync(path.resolve(cwd));
    const discovery = discoverWorkflowFiles(root, process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir(), trusted);
    for (const error of discovery.errors) console.error(`[pi-mesh] ${error}`);
    const occupied = new Set((pi.getCommands?.() ?? []).map((command) => command.name));
    for (const workflow of discovery.workflows) {
      if (!workflowNames.has(workflow.name) && occupied.has(workflow.name)) { console.error(`[pi-mesh] Workflow command conflicts with an existing command: ${workflow.name}`); continue; }
      if (workflowNames.has(workflow.name)) continue;
      workflowNames.add(workflow.name);
      pi.registerCommand(workflow.name, { description: workflow.description ?? `Run mesh workflow ${workflow.name}`, handler: (args, ctx) => runWorkflow(workflow.name, args, ctx) });
    }
  };
  pi.registerTool({
    name: "mesh", label: "Mesh",
    description: "Host-owned persistent child-agent mesh for complex, parallel, or broad work, with dynamically discovered specialized agents, dependency graphs, optional Git worktree isolation, retries, recovery, mailbox, and host-approved growth.",
    promptSnippet: "Launch and coordinate specialized sub-agents for complex, parallel, or broad work",
    promptGuidelines: [
      "Before the first mesh run in a project, or whenever agent selection is uncertain, call mesh with action list_agents and choose from the returned bundled, user, and project agents. Treat each description as the agent's routing contract; do not infer capabilities from its name alone. When reading an Agent definition, use the exact absolute definition path returned by list_agents; never guess an agents/ directory, and remember that cwd changes do not persist across separate tool calls.",
      "Use mesh when work has independent branches, needs specialized review, or broad exploration would flood the main context. Use direct read, grep, and find tools when the target is already known and narrow.",
      "Do not duplicate work already delegated to mesh nodes. Consume their bounded evidence and synthesize the results.",
      "If a run partially fails, call retry_failed on that run instead of creating replacement IDs or resubmitting successful nodes. User/unknown stops require the genuine user command /mesh retry <run-id>; never bypass a stop by creating a new ID or claiming authorization in tool parameters. It resumes the failed node's persisted Agent session when available and otherwise supplies the previous error and output as repair context.",
      "Mesh runs are background by default. After run returns, never poll status/list or call sleep to wait. If the Mesh result is all you are waiting for, end the current turn; otherwise continue independent Host work. The completion notification is delivered between turns or wakes an idle Host. Set async=false only when blocking is explicitly required.",
      "To continue after a successful background completion without new user input, predeclare continuationTasks on the initial user-authorized run. The notification allows only one mesh continue with that parent runId and no other parameters: the exact fixed plan, at most four sequential ten-minute tasks, no retries/recursive continuation. Unplanned tasks still require the user.",
      "In mesh, only the host approves growth. Enable mesh worktree mode for parallel writers; it requires a clean Git checkout. Use mesh recover after reopening the same Pi session to restart interrupted runs.",
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
      for (const [id, plan] of plans) if (Date.now() >= plan.expires) plans.delete(id);
      if (params.continuationTasks && (params.action !== "run" || params.async === false)) throw new Error("continuationTasks is only supported on an initial background run");
      if (params.action === "continue" && Object.keys(params).some(k => k !== "action" && k !== "runId")) throw new Error("continue accepts only action/runId; the plan is immutable");
      if (params.action.startsWith("bridge_")) {
        const details = await bridge.execute(params.action, params, signal, ctx);
        return { content: [{ type: "text", text: boundedText(JSON.stringify(details)) }], details: boundedDetails({ action: params.action, ...details }) };
      }
      const projectTrusted = ctx.isProjectTrusted?.() ?? false;
      const sessionId = ctx.sessionManager.getSessionId();
      const { manager, settings, notifier, resolveAgent } = currentManager(ctx.cwd, projectTrusted, sessionId, ctx.modelRegistry);
      const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      if (ctx.mode === "tui") fleet.bindMesh(ctx, manager, `${fs.realpathSync(path.resolve(ctx.cwd))}\0${sessionId}`);
      const requestedScope: AgentScope = params.scope ?? "all";
      const scope: AgentScope = !projectTrusted && requestedScope === "project" ? "project" : requestedScope;
      if (params.action === "list_agents") {
        const root = fs.realpathSync(path.resolve(ctx.cwd));
        const agents = discoverAgents(root, { scope, includeProject: projectTrusted, projectRoot: root }).map(({ name, description, source, tools, model, filePath }) => ({ name, description, source, tools, model, filePath }));
        const text = agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}\n  definition: ${agent.filePath}`).join("\n") || "No agents found.";
        return { content: [{ type: "text", text: boundedText(text) }], details: boundedDetails({ action: params.action, count: agents.length, agents }) };
      }
      if (params.action === "list") {
        const runs = manager.list();
        const text = runs.map((run) => `${run.id} ${run.status} (${run.nodes.length} nodes)`).join("\n") || "No mesh runs.";
        return { content: [{ type: "text", text: boundedText(text) }], details: boundedDetails({ action: params.action, count: runs.length, runs: runs.map((item) => compactRun(item)), diagnostics: manager.diagnostics }) };
      }
      if (params.action === "recover") {
        const resumed: string[] = [];
        manager.recover(ctx.cwd);
        for (const run of manager.list()) if (run.status === "running") { watchBackground(manager.resumeRecovered(run.id), notifier, run.id); resumed.push(run.id); }
        return { content: [{ type: "text", text: boundedText(`${resumed.length ? `Resumed: ${resumed.join(", ")}` : "No interrupted runs."}${manager.diagnostics.length ? `\nRecovery diagnostics:\n${manager.diagnostics.slice(-16).join("\n")}` : ""}`) }], details: boundedDetails({ action: params.action, resumed, diagnostics: manager.diagnostics }) };
      }
      if (!params.runId && params.action !== "run") throw new Error("runId is required");
      const run = params.runId ? manager.get(params.runId) : undefined;
      if (params.runId && !run) throw new Error(`Unknown mesh run: ${params.runId}`);

      if (params.action === "continue") {
        const plan = plans.get(params.runId!);
        if (!plan || plan.sessionId !== sessionId || plan.cwd !== fs.realpathSync(path.resolve(ctx.cwd)) || !successfulEpoch(run!, plan.epoch) || signal?.aborted || !plan.permit.claim(_toolCallId)) throw new Error("Continuation expired, revoked, replayed or not authorized for this exact Host/run epoch; ask the local user");
        plans.delete(params.runId!); // Consume before create; failures do not refund authority.
        const next = manager.create({ tasks: plan.tasks, cwd: plan.cwd, operator: "sequence", maxConcurrency: 1, maxNodes: plan.tasks.length });
        watchBackground(manager.startCreated(next.id), notifier, next.id);
        return { content: [{ type: "text", text: `Started fixed continuation ${next.id} for ${run!.id}. End the turn if waiting; no polling.` }], details: boundedDetails({ action: params.action, parentRunId: run!.id, run: compactRun(next) }) };
      }
      if (params.action === "status") return { content: [{ type: "text", text: summarize(run!) }], details: boundedDetails({ action: params.action, run: compactRun(run!, true), usage: run!.usage }), usage: piUsage(manager.claimUsage(run!.id)) };
      if (params.action === "handoff_list") {
        const handoffs = run!.nodes.flatMap((node) => (node.worktreeHistory ?? (node.worktree ? [node.worktree] : [])).filter((state) => state.finalCommit).map((state) => ({
          nodeId: node.id, attempt: state.attempt, branch: state.branch, commit: state.finalCommit, baseCommit: state.handoffBaseCommit ?? state.baseCommit, patchPath: state.patchPath, handoffPath: state.handoffPath,
        })));
        const archivedEvidence = run!.nodes.filter(node => node.evidencePath).map(node => ({ nodeId: node.id, evidencePath: node.evidencePath }));
        const text = handoffs.map((item) => `${item.nodeId} attempt ${item.attempt}\n  branch: ${item.branch}\n  commit: ${item.commit}\n  integrate: git cherry-pick ${item.baseCommit}..${item.commit}\n  patch: ${item.patchPath ?? "none"}`).join("\n") || "No handoffs.";
        return { content: [{ type: "text", text: boundedText(`${text}\n${archivedEvidence.map(item => `Full earlier history (follow previous links): ${item.nodeId} ${item.evidencePath}`).join("\n")}`, runFile(run!.cwd, run!.id)) }], details: boundedDetails({ action: params.action, count: handoffs.length, handoffs: handoffs.slice(0, 256), archivedEvidence }) };
      }
      if (params.action === "cancel") {
        if (!manager.cancel(params.runId!, params.nodeId, "operator")) throw new Error("Run/node is not cancellable");
        return { content: [{ type: "text", text: `Cancelled ${params.nodeId ?? params.runId}.` }], details: boundedDetails({ action: params.action, run: compactRun(run!) }) };
      }
      if (params.action === "pause") {
        if (!manager.pause(params.runId!)) throw new Error("Run is not pausable");
        return { content: [{ type: "text", text: `Paused ${params.runId}. Running children finish; queued children wait.` }], details: boundedDetails({ action: params.action, run: compactRun(run!) }) };
      }
      if (params.action === "retry_failed") {
        const background = params.async !== false;
        const update = (value: MeshRun) => onUpdate?.({ content: [{ type: "text", text: `${value.nodes.filter((node) => terminalNodeStatuses.has(node.status)).length}/${value.nodes.length} complete` }], details: boundedDetails({ action: params.action, run: compactRun(value) }) });
        const retry = manager.retryFailed(params.runId!, background ? undefined : signal, background ? undefined : update);
        if (background) {
          watchBackground(retry, notifier, params.runId!);
          return { content: [{ type: "text", text: `Retrying ${params.runId} in background. Do not sleep or poll. If this result is all you are waiting for, end the turn; completion will wake the Host.` }], details: boundedDetails({ action: params.action, run: compactRun(run!) }) };
        }
        const completed = await retry;
        return { content: [{ type: "text", text: summarize(completed) }], details: boundedDetails({ action: params.action, run: compactRun(completed, true) }), usage: piUsage(manager.claimUsage(completed.id)) };
      }
      if (params.action === "resume") {
        const resumed = manager.resume(params.runId!); watchBackground(resumed, notifier, params.runId!);
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
        const recipients = params.action === "message_broadcast" ? run!.nodes.map((node) => node.id) : [params.to ?? ""];
        if (recipients.some((id) => !run!.nodes.some((node) => node.id === id))) throw new Error("Unknown recipient node");
        const sent: ControlMessage[] = recipients.map((to) => ({ id: crypto.randomUUID(), runId: run!.id, from: "host", source: "host", displayFrom: params.from, to, content: params.content!.trim(), createdAt: Date.now() }));
        const receipt = await storeMessages(run!.cwd, sent, { payloadMaxBytes: settings.messagePayloadMaxBytes, recipientUnreadMaxBytes: settings.recipientUnreadMaxBytes }, (message) => manager.notifyMessageStored(message));
        if (sent.length === 1 && receipt.receipts[0]?.outcome === "not-stored") throw new Error(receipt.receipts[0]?.error);
        return { content: [{ type: "text", text: `Stored ${receipt.stored}/${sent.length} message(s).${receipt.partial ? " Partial delivery." : ""} For retries, retry only not-stored recipients; inspect unknown IDs before resending. Mailbox storage is not business completion; inspect receipts for durability/notification warnings or unknown outcomes.` }], details: { action: params.action, ...messageReceiptDetails(receipt) } };
      }
      if (params.action === "growth_list") {
        const proposals = growthProposals<MeshTask[]>(run!.cwd, run!.id).map((proposal) => growthReceipt(proposal, run!));
        return { content: [{ type: "text", text: boundedText(JSON.stringify(proposals), runFile(run!.cwd, run!.id)) }], details: boundedDetails({ action: params.action, count: proposals.length, proposals: proposals.slice(0, 256) }) };
      }
      if (params.action === "growth_decide") {
        if (!params.proposalId || !params.decision) throw new Error("proposalId and decision are required");
        const pending = growthProposals<MeshTask[]>(run!.cwd, run!.id).find((item) => item.id === params.proposalId);
        const tasks = params.decision === "approve" && pending ? resolveTaskModels(pending.tasks, ctx.modelRegistry, inheritedModel, resolveAgent) : undefined;
        const shouldResume = manager.decideGrowth(run!.id, params.proposalId, params.decision, tasks);
        const proposal = growthProposals<MeshTask[]>(run!.cwd, run!.id).find((item) => item.id === params.proposalId)!;
        if (shouldResume) watchBackground(manager.resume(run!.id), notifier, run!.id);
        return { content: [{ type: "text", text: `Growth ${proposal.status}: ${proposal.id}.${shouldResume ? " Mesh resumed." : ""}` }], details: boundedDetails({ action: params.action, proposal: growthReceipt(proposal, run!), run: compactRun(run!) }) };
      }

      if (!params.tasks?.length) throw new Error("tasks is required for run");
      const update = (value: MeshRun) => onUpdate?.({ content: [{ type: "text", text: `${value.nodes.filter((node) => terminalNodeStatuses.has(node.status)).length}/${value.nodes.length} complete` }], details: boundedDetails({ action: params.action, run: compactRun(value) }) });
      if (signal?.aborted) throw new Error("Mesh run cancelled before creation");
      const planned = params.continuationTasks ? resolveTaskModels(continuationTasks(params.continuationTasks), ctx.modelRegistry, inheritedModel, resolveAgent) : undefined;
      if (planned && plans.size >= 16) throw new Error("Continuation plan budget exhausted for this user turn");
      const permit = planned ? requestContinuation(pi, ctx, _toolCallId, params) : undefined;
      const createdRun = manager.create({ tasks: resolveTaskModels(params.tasks as MeshTask[], ctx.modelRegistry, inheritedModel, resolveAgent), cwd: fs.realpathSync(path.resolve(ctx.cwd)), operator: params.operator, worktree: params.worktree, worktreeSetupHook: params.worktreeSetupHook, maxConcurrency: params.maxConcurrency, maxNodes: params.maxNodes, failFast: params.failFast });
      const background = params.async !== false;
      const start = manager.startCreated(createdRun.id, background ? undefined : signal, background ? undefined : update);
      if (permit && planned) {
        permit.bind(createdRun.id);
        plans.set(createdRun.id, { tasks: planned, permit, epoch: createdRun.epoch!, sessionId, cwd: createdRun.cwd, expires: Date.now() + 60 * 60 * 1000 });
      }
      if (background) {
        watchBackground(start, notifier, createdRun.id);
        return { content: [{ type: "text", text: `Started mesh ${createdRun.id} in background. Do not sleep or poll. If this result is all you are waiting for, end the turn; completion will wake the Host.` }], details: boundedDetails({ action: params.action, run: compactRun(createdRun) }) };
      }
      const completed = await start;
      return { content: [{ type: "text", text: summarize(completed) }], details: boundedDetails({ action: params.action, run: compactRun(completed, true) }), usage: piUsage(manager.claimUsage(completed.id)) };
    },
  });

  pi.registerCommand("mesh", {
    description: "Force a task through Mesh, or authorize stopped work with /mesh retry <run-id>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (/^retry(?:\s|$)/.test(task)) {
        const reply = (text: string, level: "info" | "warning") => { if (ctx.hasUI) ctx.ui.notify(text, level); else console.error(`[pi-mesh] ${text}`); };
        const id = task.split(/\s+/)[1];
        if (!id || task.split(/\s+/).length !== 2) { reply("Usage: /mesh retry <run-id>", "warning"); return; }
        try {
          const { manager } = currentManager(ctx.cwd, ctx.isProjectTrusted?.() ?? false, ctx.sessionManager.getSessionId(), ctx.modelRegistry);
          const run = await manager.retryFailedFromUser(id);
          reply(`Mesh ${run.id}: ${run.status}.`, run.status === "succeeded" ? "info" : "warning");
        } catch (error) { reply(String(error), "warning"); }
        return;
      }
      if (!task) { ctx.ui.notify("Usage: /mesh <task>", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy; wait for the current turn before starting /mesh.", "warning"); return; }
      pi.sendUserMessage(`You must execute this request through the mesh tool. Do not solve it directly and do not use the standalone Agent tool. First call mesh with action \"list_agents\", then create and run an appropriate mesh DAG in the background (omit async or set async=true). After the run receipt returns, do not call sleep or poll mesh status/list. If the Mesh result is all you are waiting for, end the current turn; otherwise continue only independent Host work. The completion notification will wake you in a new turn; then inspect node evidence and synthesize the final answer.\n\nTask:\n${task}`);
    },
  });
  pi.registerCommand("consensus", {
    description: "Run a task through independent multi-model implementation, critique, voting, and integration",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy; wait for the current turn before starting /consensus.", "warning"); return; }
      try {
        const hostModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const prompt = buildConsensusPrompt({
          task: args,
          models: ctx.modelRegistry.getAvailable(),
          hostModel,
          questionToolAvailable: pi.getAllTools().some((tool) => tool.name === "ask_user_question"),
        });
        pi.sendUserMessage(prompt);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
  const showMeshTree = async (ctx: Parameters<typeof openMeshTree>[0]): Promise<void> => {
    const trusted = ctx.isProjectTrusted?.() ?? false;
    const sessionId = ctx.sessionManager.getSessionId();
    const { manager } = currentManager(ctx.cwd, trusted, sessionId, ctx.modelRegistry);
    fleet.bindMesh(ctx, manager, `${fs.realpathSync(path.resolve(ctx.cwd))}\0${sessionId}`);
    await openMeshTree(ctx, manager);
  };
  pi.registerCommand("mesh-tree", {
    description: "Open the native Mesh tree inspector",
    handler: async (args, ctx) => {
      if (args.trim()) return void ctx.ui.notify("Usage: /mesh-tree", "warning");
      await showMeshTree(ctx);
    },
  });
  pi.registerShortcut("ctrl+shift+m", { description: "Open the native Mesh tree inspector", handler: showMeshTree });
  const shutdownSubagents = registerCompatibilityTools(pi, fleet);
  const bridge = registerHostBridge(pi, ctx => {
    const root = fs.realpathSync(path.resolve(ctx.cwd));
    const entry = managers.get(`${root}\0${ctx.sessionManager.getSessionId()}`);
    if (entry) currentManager(root, ctx.isProjectTrusted?.() ?? false, ctx.sessionManager.getSessionId(), ctx.modelRegistry);
    return entry?.manager;
  }, shutdownSubagents.getManager);
  pi.on("session_start", (_event, ctx) => {
    plans.clear();
    const trusted = ctx.isProjectTrusted?.() ?? false;
    registerWorkflows(ctx.cwd, trusted);
    const sessionId = ctx.sessionManager.getSessionId();
    const { manager } = currentManager(ctx.cwd, trusted, sessionId, ctx.modelRegistry);
    if (ctx.hasUI) fleet.bindMesh(ctx, manager, `${fs.realpathSync(path.resolve(ctx.cwd))}\0${sessionId}`);
  });
  pi.on("session_shutdown", async () => {
    plans.clear();
    await Promise.allSettled([...managers.values()].map(async ({ manager, releaseFleet }) => { await manager.shutdown(); releaseFleet(); }));
    for (const { notifier } of managers.values()) notifier.dispose();
    managers.clear();
    await shutdownSubagents();
  });
}
