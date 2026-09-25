import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { CHILD_OUTPUT_DISCLAIMER, CompletionNotifier } from "./notifications.ts";
import { resolveAgentModel } from "./model-resolution.ts";
import { defaultMeshSettings, loadMeshSettings } from "./settings.ts";
import { SessionAgentManager, type SessionAgentRecord } from "./session-agents.ts";
import { AgentScheduler } from "./scheduler.ts";
import { FleetView } from "./fleet-view.ts";
import { retainSessionFleetLimiter, sessionFleetLimiter } from "./fleet-limiter.ts";
import { registerSubagentRpc } from "./subagent-rpc.ts";
import { boundedDisplay, inheritedContext, readBoundedFile, type Usage } from "./runtime-utils.ts";
import { showSchedulesMenu } from "./schedule-menu.ts";

const agentParams = Type.Object({
  prompt: Type.String({ description: "Task for the autonomous agent." }),
  description: Type.String({ description: "Short 3-5 word display summary." }),
  subagent_type: Type.String({ description: "Agent type returned by mesh list_agents." }),
  model: Type.Optional(Type.String()), thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), run_in_background: Type.Optional(Type.Boolean()), resume: Type.Optional(Type.String()),
  isolated: Type.Optional(Type.Boolean()), inherit_context: Type.Optional(Type.Boolean()), isolation: Type.Optional(Type.Literal("worktree")),
  schedule: Type.Optional(Type.String({ description: "One-shot +10m, interval 10m, future ISO timestamp, or six-field cron." })),
}, { additionalProperties: false });

function result(text: string, details: unknown = {}, usage?: any) { return { content: [{ type: "text" as const, text }], details, ...(usage ? { usage } : {}) }; }
function piUsage(usage?: Usage) {
  if (!usage) return undefined;
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: usage.costInput ?? 0, output: usage.costOutput ?? 0, cacheRead: usage.costCacheRead ?? 0, cacheWrite: usage.costCacheWrite ?? 0, total: usage.cost } };
}
function writeProjectSetting(root: string, patch: Record<string, unknown>): void {
  const file = path.join(root, CONFIG_DIR_NAME, "mesh", "settings.yaml");
  const settings = loadMeshSettings(root, { ...process.env, PI_CODING_AGENT_DIR: path.join(root, ".pi-mesh-empty-global") }, true);
  const current = Object.fromEntries(Object.entries(settings).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaultMeshSettings[key as keyof typeof defaultMeshSettings])));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, stringify({ ...current, ...patch }), { mode: 0o600 });
}
function recordText(record: SessionAgentRecord, verbose = false): string {
  const head = `Agent: ${record.id}
Generation: ${record.generation ?? 0} | Stop: ${record.result?.stopReason ?? "pending"} | Partial: ${Boolean(record.result?.partial)}\nType: ${record.agent.name} | Status: ${record.status}\nDescription: ${record.description}\nDiagnostic: ${record.result?.error ?? record.error ?? record.recoveryDiagnostic ?? "none"}`;
  const output = record.result?.output || record.result?.error || record.error || (record.status === "running" ? "Agent is still running." : "No output.");
  const conversation = verbose && !record.recoveryDiagnostic ? (record.execution?.conversation() || (record.launch?.transcriptPath ? (() => { try { return readBoundedFile(record.launch!.transcriptPath!); } catch { return ""; } })() : "")) : undefined;
  const artifact = record.outputTruncated && record.outputPath ? `\nFull output: ${record.outputPath}` : "";
  const handoff = record.worktree?.finalCommit ? `\n\nWorktree branch: ${record.worktree.branch}\nFinal commit: ${record.worktree.finalCommit}\nPatch: ${record.worktree.patchPath ?? "none"}\nHandoff: ${record.worktree.handoffPath ?? "none"}` : "";
  return boundedDisplay(`${CHILD_OUTPUT_DISCLAIMER}\n\n${head}${artifact}${handoff}\n\n--- Untrusted child output ---\n${output}${conversation ? `\n\n--- Agent Conversation (untrusted) ---\n${conversation}` : ""}`);
}

export function registerCompatibilityTools(pi: ExtensionAPI, fleet = new FleetView()): (() => Promise<void>) & { getManager(ctx: ExtensionContext): SessionAgentManager | undefined } {
  let closed = false;
  const managers = new Map<string, { manager: SessionAgentManager; notifier: CompletionNotifier; releaseFleet: () => void }>();
  const schedulers = new Map<string, AgentScheduler>();
  const schedulerContexts = new Map<string, ExtensionContext>();
  const managerFor = (ctx: ExtensionContext) => {
    if (closed) throw new Error("Direct tools are shut down.");
    const trusted = ctx.isProjectTrusted?.() ?? false;
    const root = fs.realpathSync(path.resolve(ctx.cwd));
    const sessionId = ctx.sessionManager.getSessionId();
    const key = `${root}\0${sessionId}`;
    schedulerContexts.set(key, ctx);
    let entry = managers.get(key);
    if (!entry) {
      const settings = loadMeshSettings(root, process.env, trusted);
      const notifier = new CompletionNotifier(pi, settings);
      const limiter = sessionFleetLimiter(sessionId, settings.maxConcurrentAgents);
      const manager = new SessionAgentManager(settings, root, undefined, sessionId, limiter, ctx.modelRegistry, trusted);
      for (const diagnostic of manager.diagnostics) pi.events.emit("subagents:diagnostic", diagnostic);
      manager.setOnStart((record) => pi.events.emit("subagents:started", { id: record.id, type: record.agent.name, description: record.description }));
      manager.setOnComplete((record) => {
        const usage = record.result?.usage;
        pi.events.emit(record.status === "completed" ? "subagents:completed" : record.status === "stopped" ? "subagents:stopped" : "subagents:failed", { id: record.id, type: record.agent.name, description: record.description, result: record.result?.output, error: record.result?.error ?? record.error, status: record.status, durationMs: (record.completedAt ?? Date.now()) - record.createdAt, toolUses: record.activity?.toolUses ?? 0, tokens: usage ? { input: usage.input, output: usage.output, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite } : undefined });
        notifier.enqueue(record, (item) => `${recordText(item)}\nNext action: ${manager.nextAction(item)}`);
      });
      entry = { manager, notifier, releaseFleet: retainSessionFleetLimiter(sessionId, limiter) };
      managers.set(key, entry);
    }
    entry.manager.updateAuthorization(loadMeshSettings(root, process.env, trusted), trusted);
    return { manager: entry.manager, trusted, root, key, sessionId };
  };

  const schedulerFor = (ctx: ExtensionContext) => {
    const root = fs.realpathSync(path.resolve(ctx.cwd)); const sessionId = ctx.sessionManager.getSessionId();
    const key = `${root}\0${sessionId}`;
    schedulerContexts.set(key, ctx);
    let scheduler = schedulers.get(key);
    if (!scheduler) {
      scheduler = new AgentScheduler(root, sessionId, (job) => {
        if (closed) return;
        // Ask the live Host at fire time; never capture a permanent trust decision.
        const { manager, trusted } = managerFor(schedulerContexts.get(key)!);
        const selected = discoverAgents(root, { includeProject: trusted, projectRoot: root, onDiagnostic: (diagnostic) => pi.events.emit("subagents:diagnostic", diagnostic) }).find((item) => item.name === job.agent);
        if (!selected) throw new Error("Agent no longer trusted/enabled; use mesh list_agents and discovery diagnostics.");
        const record = manager.spawn(selected, job.prompt, job.name, root, { model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, persistent: job.persistent, transcript: job.transcript });
        pi.events.emit("subagents:scheduled", { type: "fired", jobId: job.id, agentId: record.id });
      }, (job, error) => pi.events.emit("subagents:scheduled", { type: "error", jobId: job.id, error: String(error) }));
      schedulers.set(key, scheduler);
    }
    return scheduler;
  };
  const recordResult = (manager: SessionAgentManager, record: SessionAgentRecord, verbose = false, foreground = false) => result(
    boundedDisplay(`${recordText(record, verbose)}\nNext action: ${manager.nextAction(record)}`),
    { agentId: record.id, status: record.status, generation: record.generation, partial: record.result?.partial, stopReason: record.result?.stopReason, outputPath: record.outputPath, outputTruncated: record.outputTruncated, cumulativeUsage: record.cumulativeUsage, usageAccounting: "Any attached usage is previously unreported child execution work; querying does not make a model call.", nextAction: manager.nextAction(record) }, piUsage(manager.claimUsage(record.id, foreground ? record.generation : undefined)));

  pi.registerTool({
    name: "Agent", label: "Agent",
    description: "Launch one autonomous sub-agent. Use mesh for dependency graphs; mesh nodes use the same internal subagent runtime.",
    promptSnippet: "Launch an autonomous specialized agent",
    promptGuidelines: ["Use Agent for one autonomous task; use mesh for multi-node dependency graphs. Do not duplicate delegated work."],
    parameters: agentParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const { manager, trusted, root } = managerFor(ctx);
      if (signal?.aborted) throw new Error("Agent launch cancelled.");
      if (params.resume !== undefined) {
        if (!params.resume.trim()) throw new Error("Agent resume requires a nonblank ID. Use resume, prompt, description, and subagent_type; or omit resume to create a new Agent.");
        const spawnOnlyOptions = Object.entries({ schedule: params.schedule, isolation: params.isolation, isolated: params.isolated || undefined, inherit_context: params.inherit_context || undefined, model: params.model, thinking: params.thinking, max_turns: params.max_turns, run_in_background: params.run_in_background || undefined })
          .filter(([, value]) => value !== undefined).map(([name]) => name);
        if (spawnOnlyOptions.length) throw new Error(`Agent resume rejected: remove spawn-only option(s): ${spawnOnlyOptions.join(", ")}. Retry with only resume, prompt, description, and subagent_type. To change launch settings, omit resume and start a new Agent; to redirect a running Agent, use steer_subagent.`);
        const resumed = manager.resume(params.resume, params.prompt, { foreground: true });
        const abort = () => manager.abort(params.resume!, "unknown");
        signal?.addEventListener("abort", abort, { once: true });
        try { return recordResult(manager, await resumed, false, true); } finally { signal?.removeEventListener("abort", abort); }
      }
      const agent = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root, onDiagnostic: (diagnostic) => pi.events.emit("subagents:diagnostic", diagnostic) }).find((item) => item.name.toLowerCase() === params.subagent_type.toLowerCase());
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type}. Use mesh(action="list_agents") and review subagents:diagnostic events.`);
      const inheritContext = agent.inheritContext ?? params.inherit_context ?? false;
      const parentContext = inheritContext ? inheritedContext(ctx.sessionManager.getBranch()) : undefined;
      const background = agent.runInBackground ?? params.run_in_background ?? false;
      const isolated = agent.isolated ?? params.isolated ?? false;
      const effectiveAgent = isolated ? { ...agent, isolated: true } : agent;
      const worktree = agent.isolation === "worktree" || params.isolation === "worktree";
      if (params.schedule) {
        if (inheritContext || worktree || isolated) throw new Error("schedule cannot be combined with inherit_context, isolated, or worktree isolation");
        const scheduler = schedulerFor(ctx);
        const model = resolveAgentModel([params.model, agent.model, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined].find((value) => value?.trim()), ctx.modelRegistry);
        const persistent = agent.persistSession ?? false;
        const job = scheduler.add({ name: params.description, schedule: params.schedule, prompt: params.prompt, agent: agent.name, model, thinking: agent.thinking ?? params.thinking, maxTurns: agent.maxTurns ?? params.max_turns, persistent, transcript: agent.outputTranscript });
        pi.events.emit("subagents:scheduled", { type: "added", jobId: job.id, schedule: params.schedule });
        return result(`Scheduled agent ${job.id}. Next run: ${job.nextRun ? new Date(job.nextRun).toISOString() : "cron"}.`, { jobId: job.id, status: "scheduled" });
      }
      const selectedModel = resolveAgentModel([params.model, agent.model, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined].find((value) => value?.trim()), ctx.modelRegistry);
      const persistent = agent.persistSession ?? false;
      const record = manager.spawn(effectiveAgent, params.prompt, params.description, root, { model: selectedModel, thinking: agent.thinking ?? params.thinking, maxTurns: agent.maxTurns ?? params.max_turns, persistent, parentContext, worktree });
      record.foreground = !background;
      const abort = () => manager.abort(record.id, "unknown");
      signal?.addEventListener("abort", abort, { once: true });
      void record.promise?.then(() => signal?.removeEventListener("abort", abort), () => signal?.removeEventListener("abort", abort));
      pi.events.emit("subagents:created", { id: record.id, type: agent.name, description: params.description, isBackground: background });
      if (background) return result(`Agent ${record.status === "queued" ? "queued" : "started in background"}.\nAgent ID: ${record.id}\nType: ${agent.name}\nDescription: ${params.description}\n\nYou will be notified when this agent completes.`, { agentId: record.id, status: record.status === "queued" ? "queued" : "background" });
      const timer = setInterval(() => onUpdate?.(result(`Agent ${record.id} is running…`, { agentId: record.id, status: "running" })), 500); timer.unref?.();
      try { await record.promise; } finally { clearInterval(timer); }
      return recordResult(manager, record, false, true);
    },
  });

  pi.registerTool({
    name: "get_subagent_result", label: "Get Agent Result", description: "Check status and retrieve a background Agent result.", promptSnippet: "Check status and retrieve a background Agent result",
    parameters: Type.Object({ agent_id: Type.String(), wait: Type.Optional(Type.Boolean()), verbose: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { manager } = managerFor(ctx); const record = manager.get(params.agent_id); if (!record) throw new Error(`Agent not found: ${params.agent_id}`);
      if (params.wait) while (record.settling || ["queued", "running"].includes(record.status)) {
        if (signal?.aborted) throw new Error("Wait cancelled");
        if (record.promise) await Promise.race([record.promise, new Promise((resolve) => setTimeout(resolve, 25))]);
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (params.wait) for (const entry of managers.values()) if (entry.manager === manager) entry.notifier.flush();
      return recordResult(manager, record, params.verbose);
    },
  });

  pi.registerTool({
    name: "steer_subagent", label: "Steer Agent", description: "Send a steering message to a running Agent session.", promptSnippet: "Redirect a running Agent",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1, maxLength: 32768 }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) { const { manager } = managerFor(ctx); manager.steer(params.agent_id, params.message); pi.events.emit("subagents:steered", { id: params.agent_id, message: params.message }); return result(`Steering message sent to agent ${params.agent_id}.`); },
  });

  pi.registerTool({
    name: "send_subagent", label: "Contact Agent", description: "Host-only, opt-in direction to an existing Direct Agent. Disabled unless directCommunication=true. Receipt is acceptance, NOT completion; never unlocks user/unknown cancellation.",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1, maxLength: 32768 }), expected_generation: Type.Optional(Type.Integer({ minimum: 0 })), message_id: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Direction cancelled.");
      const { manager } = managerFor(ctx);
      const abort = () => manager.abort(params.agent_id, "unknown");
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const receipt = await manager.send(params.agent_id, params.message, params.expected_generation, params.message_id);
        return result(`Direction ${receipt.disposition}; this receipt does not mean execution completed. Use get_subagent_result to check.`, receipt);
      } finally { signal?.removeEventListener("abort", abort); }
    },
  });

  pi.registerCommand("agents", {
    description: "Manage pi-mesh agents and active subagents",
    handler: async (_args, ctx) => {
      // This command handler is a real user surface, not a tool/peer parameter.
      const authorized = _args.match(/^resume\s+(\S+)\s+([\s\S]+)$/);
      if (authorized) {
        const { manager } = managerFor(ctx);
        try { const record = await manager.resume(authorized[1]!, authorized[2]!, { userAuthorized: true }); if (ctx.hasUI) ctx.ui.notify(recordText(record), "info"); }
        catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), "error"); else console.error(String(error)); }
        return;
      }
      if (!ctx.hasUI) { console.error("The /agents command requires a dialog UI."); return; }
      const { manager, trusted, root } = managerFor(ctx);
      const agents = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root, onDiagnostic: (diagnostic) => pi.events.emit("subagents:diagnostic", diagnostic) });
      const scheduler = schedulerFor(ctx);
      const choice = await ctx.ui.select("Agents", ["Running agents", "Agent types", "Scheduled jobs", "Create project agent", "Settings"]);
      if (choice === "Running agents") {
        await fleet.select(ctx, manager);
      } else if (choice === "Scheduled jobs") {
        await showSchedulesMenu(ctx, scheduler);
      } else if (choice === "Agent types") {
        const selected = await ctx.ui.select("Agent types", agents.map((agent) => `${agent.name} · ${agent.source} · ${agent.description}`));
        if (selected) {
          const name = selected.split(" · ")[0]!; const agent = agents.find((item) => item.name === name)!;
          const action = await ctx.ui.select(name, agent.source === "bundled" ? ["Eject to project", "View"] : ["Edit", "Disable", "Delete", "View"]);
          const projectFile = path.join(root, CONFIG_DIR_NAME, "agents", `${name}.md`);
          if (action === "View") await ctx.ui.editor(name, fs.readFileSync(agent.filePath, "utf8"));
          if (action === "Eject to project") { fs.mkdirSync(path.dirname(projectFile), { recursive: true, mode: 0o700 }); fs.copyFileSync(agent.filePath, projectFile); ctx.ui.notify(`Ejected ${projectFile}`, "info"); }
          if (action === "Edit") { const content = await ctx.ui.editor(name, fs.readFileSync(agent.filePath, "utf8")); if (content) fs.writeFileSync(agent.filePath, content, { mode: 0o600 }); }
          if (action === "Disable") { const source = fs.readFileSync(agent.filePath, "utf8"); fs.writeFileSync(agent.filePath, source.replace(/^---\n/, "---\nenabled: false\n"), { mode: 0o600 }); }
          if (action === "Delete" && agent.source !== "bundled") fs.rmSync(agent.filePath);
        }
      } else if (choice === "Create project agent") {
        if (!trusted) return void ctx.ui.notify("Trust the project before creating a project agent.", "warning");
        const name = await ctx.ui.input("Agent name", "my-agent"); if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) return;
        const description = await ctx.ui.input("Description", "When should the parent choose this agent?"); if (!description) return;
        const prompt = await ctx.ui.editor("System prompt", "Perform the assigned task. Do not create child agents."); if (!prompt) return;
        const file = path.join(root, CONFIG_DIR_NAME, "agents", `${name}.md`); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n${prompt}\n`, { mode: 0o600 });
        ctx.ui.notify(`Created ${file}`, "info");
      } else if (choice === "Settings") {
        const settings = loadMeshSettings(root, process.env, trusted);
        const item = await ctx.ui.select("Agent settings", ["Max concurrency", "Join mode"]);
        if (item === "Max concurrency") {
          const value = await ctx.ui.input("Max concurrency", String(settings.maxConcurrentAgents));
          if (value && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 32) writeProjectSetting(root, { maxConcurrentAgents: Number(value) });
        }
        if (item === "Join mode") {
          const value = await ctx.ui.select("Join mode", ["smart", "async", "group"]);
          if (value) writeProjectSetting(root, { joinMode: value });
        }
        ctx.ui.notify("Settings saved; use /reload to apply.", "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    schedulerFor(ctx);
    const { manager, key } = managerFor(ctx);
    if (!ctx.hasUI) return;
    fleet.bind(ctx, manager, key);
  });

  pi.registerShortcut("ctrl+shift+a", {
    description: "Open the pi-mesh agent fleet",
    handler: async (ctx) => { const { manager } = managerFor(ctx); await fleet.select(ctx, manager); },
  });

  const unregisterRpc = registerSubagentRpc(pi, managerFor);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    closed = true; unregisterRpc(); fleet.dispose();
    for (const scheduler of schedulers.values()) scheduler.dispose(); schedulers.clear(); schedulerContexts.clear();
    const results = await Promise.allSettled([...managers].map(async ([key, { manager, notifier, releaseFleet }]) => {
      const diagnosticStart = manager.diagnostics.length;
      try {
        await manager.shutdown(); // Resolves only after completion/close, even on abort checkpoint errors.
        releaseFleet(); managers.delete(key);
      } finally {
        notifier.dispose();
        for (const diagnostic of manager.diagnostics.slice(diagnosticStart)) pi.events.emit("subagents:diagnostic", diagnostic);
      }
    }));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Direct shutdown failed; undrained Managers retain Fleet ownership");
  })();
  return Object.assign(shutdown, { getManager(ctx: ExtensionContext) {
    if (closed) return undefined;
    const root = fs.realpathSync(path.resolve(ctx.cwd));
    const entry = managers.get(`${root}\0${ctx.sessionManager.getSessionId()}`);
    if (entry) entry.manager.updateAuthorization(loadMeshSettings(root, process.env, ctx.isProjectTrusted?.() ?? false), ctx.isProjectTrusted?.() ?? false);
    return entry?.manager;
  } });
}
