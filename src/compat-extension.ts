import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { CompletionNotifier } from "./notifications.ts";
import { resolveAgentModel } from "./model-resolution.ts";
import { defaultMeshSettings, loadMeshSettings } from "./settings.ts";
import { SessionAgentManager, type SessionAgentRecord } from "./session-agents.ts";
import { AgentScheduler } from "./scheduler.ts";
import { FleetView } from "./fleet-view.ts";
import { sessionFleetLimiter } from "./fleet-limiter.ts";
import { registerSubagentRpc } from "./subagent-rpc.ts";
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
function piUsage(record: SessionAgentRecord) {
  const usage = record.result?.usage; if (!usage) return undefined;
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
  const head = `Agent: ${record.id}\nType: ${record.agent.name} | Status: ${record.status}\nDescription: ${record.description}`;
  const output = record.result?.output || record.result?.error || record.error || (record.status === "running" ? "Agent is still running." : "No output.");
  const conversation = verbose ? (record.execution?.conversation() || (record.launch?.transcriptPath ? (() => { try { return fs.readFileSync(record.launch!.transcriptPath!, "utf8"); } catch { return ""; } })() : "")) : undefined;
  const artifact = record.outputTruncated && record.outputPath ? `\nFull output: ${record.outputPath}` : "";
  const handoff = record.worktree?.finalCommit ? `\n\nWorktree branch: ${record.worktree.branch}\nFinal commit: ${record.worktree.finalCommit}\nPatch: ${record.worktree.patchPath ?? "none"}\nHandoff: ${record.worktree.handoffPath ?? "none"}` : "";
  return `${head}\n\n${output}${artifact}${handoff}${conversation ? `\n\n--- Agent Conversation ---\n${conversation}` : ""}`;
}

export function registerCompatibilityTools(pi: ExtensionAPI, fleet = new FleetView()): () => Promise<void> {
  const managers = new Map<string, { manager: SessionAgentManager; notifier: CompletionNotifier }>();
  const schedulers = new Map<string, AgentScheduler>();
  const managerFor = (ctx: ExtensionContext) => {
    const trusted = ctx.isProjectTrusted?.() ?? false;
    const root = fs.realpathSync(path.resolve(ctx.cwd));
    const sessionId = ctx.sessionManager.getSessionId();
    const key = `${root}\0${trusted}\0${sessionId}`;
    let entry = managers.get(key);
    if (!entry) {
      const settings = loadMeshSettings(root, process.env, trusted);
      const notifier = new CompletionNotifier(pi, settings);
      const manager = new SessionAgentManager(settings, root, undefined, sessionId, sessionFleetLimiter(sessionId, settings.maxConcurrentAgents), ctx.modelRegistry);
      manager.setOnStart((record) => pi.events.emit("subagents:started", { id: record.id, type: record.agent.name, description: record.description }));
      manager.setOnComplete((record) => {
        const usage = record.result?.usage;
        pi.events.emit(record.status === "completed" ? "subagents:completed" : record.status === "stopped" ? "subagents:stopped" : "subagents:failed", { id: record.id, type: record.agent.name, description: record.description, result: record.result?.output, error: record.result?.error ?? record.error, status: record.status, durationMs: (record.completedAt ?? Date.now()) - record.createdAt, toolUses: record.activity?.toolUses ?? 0, tokens: usage ? { input: usage.input, output: usage.output, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite } : undefined });
        notifier.enqueue(record, recordText);
      });
      entry = { manager, notifier };
      managers.set(key, entry);
    }
    return { manager: entry.manager, trusted, root, key, sessionId };
  };

  pi.registerTool({
    name: "Agent", label: "Agent",
    description: "Launch one autonomous sub-agent. Use mesh for dependency graphs; mesh nodes use the same internal subagent runtime.",
    promptSnippet: "Launch an autonomous specialized agent",
    promptGuidelines: ["Use Agent for one autonomous task; use mesh for multi-node dependency graphs. Do not duplicate delegated work."],
    parameters: agentParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const { manager, trusted, root } = managerFor(ctx);
      if (params.resume) {
        if (params.schedule || params.isolation || params.isolated || params.inherit_context || params.model || params.thinking || params.max_turns || params.run_in_background) throw new Error("resume cannot be combined with spawn-only options");
        const resumed = manager.resume(params.resume, params.prompt);
        if (signal) signal.addEventListener("abort", () => manager.abort(params.resume!), { once: true });
        const record = await resumed;
        return result(recordText(record), { agentId: record.id, status: record.status }, piUsage(record));
      }
      const agent = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root }).find((item) => item.name.toLowerCase() === params.subagent_type.toLowerCase());
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type}`);
      const inheritContext = agent.inheritContext ?? params.inherit_context ?? false;
      const parentContext = inheritContext ? JSON.stringify(ctx.sessionManager.getBranch()).slice(-128 * 1024) : undefined;
      const background = agent.runInBackground ?? params.run_in_background ?? false;
      const isolated = agent.isolated ?? params.isolated ?? false;
      const effectiveAgent = isolated ? { ...agent, isolated: true } : agent;
      const worktree = agent.isolation === "worktree" || params.isolation === "worktree";
      if (params.schedule) {
        if (inheritContext || worktree || isolated) throw new Error("schedule cannot be combined with inherit_context, isolated, or worktree isolation");
        const sessionId = ctx.sessionManager.getSessionId();
        const schedulerKey = `${root}\0${sessionId}`;
        let scheduler = schedulers.get(schedulerKey);
        if (!scheduler) {
          scheduler = new AgentScheduler(root, sessionId, (job) => {
            const selected = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root }).find((item) => item.name === job.agent);
            if (!selected) return void pi.events.emit("subagents:scheduled", { type: "error", jobId: job.id, error: "Agent no longer exists" });
            try {
              const record = manager.spawn(selected, job.prompt, job.name, root, { model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, persistent: job.persistent, transcript: job.transcript, sessionDir: job.sessionDir });
              pi.events.emit("subagents:scheduled", { type: "fired", jobId: job.id, agentId: record.id });
            } catch (error) {
              pi.events.emit("subagents:scheduled", { type: "error", jobId: job.id, error: error instanceof Error ? error.message : String(error) });
            }
          });
          schedulers.set(schedulerKey, scheduler);
        }
        const model = resolveAgentModel([params.model, agent.model, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined].find((value) => value?.trim()), ctx.modelRegistry);
        const persistent = agent.persistSession ?? false;
        const job = scheduler.add({ name: params.description, schedule: params.schedule, prompt: params.prompt, agent: agent.name, model, thinking: agent.thinking ?? params.thinking, maxTurns: agent.maxTurns ?? params.max_turns, persistent, transcript: agent.outputTranscript, sessionDir: persistent ? ctx.sessionManager.getSessionDir() : undefined });
        pi.events.emit("subagents:scheduled", { type: "added", jobId: job.id, schedule: params.schedule });
        return result(`Scheduled agent ${job.id}. Next run: ${job.nextRun ? new Date(job.nextRun).toISOString() : "cron"}.`, { jobId: job.id, status: "scheduled" });
      }
      const selectedModel = resolveAgentModel([params.model, agent.model, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined].find((value) => value?.trim()), ctx.modelRegistry);
      const persistent = agent.persistSession ?? false;
      const record = manager.spawn(effectiveAgent, params.prompt, params.description, root, { model: selectedModel, thinking: agent.thinking ?? params.thinking, maxTurns: agent.maxTurns ?? params.max_turns, persistent, parentContext, worktree, sessionDir: persistent ? ctx.sessionManager.getSessionDir() : undefined });
      signal?.addEventListener("abort", () => manager.abort(record.id), { once: true });
      pi.events.emit("subagents:created", { id: record.id, type: agent.name, description: params.description, isBackground: background });
      if (background) return result(`Agent ${record.status === "queued" ? "queued" : "started in background"}.\nAgent ID: ${record.id}\nType: ${agent.name}\nDescription: ${params.description}\n\nYou will be notified when this agent completes.`, { agentId: record.id, status: record.status === "queued" ? "queued" : "background" });
      const timer = setInterval(() => onUpdate?.(result(`Agent ${record.id} is running…`, { agentId: record.id, status: "running" })), 500); timer.unref?.();
      try { await record.promise; } finally { clearInterval(timer); }
      return result(recordText(record), { agentId: record.id, status: record.status }, piUsage(record));
    },
  });

  pi.registerTool({
    name: "get_subagent_result", label: "Get Agent Result", description: "Check status and retrieve a background Agent result.", promptSnippet: "Check status and retrieve a background Agent result",
    parameters: Type.Object({ agent_id: Type.String(), wait: Type.Optional(Type.Boolean()), verbose: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { manager } = managerFor(ctx); const record = manager.get(params.agent_id); if (!record) throw new Error(`Agent not found: ${params.agent_id}`);
      if (params.wait) while (["queued", "running"].includes(record.status)) {
        if (signal?.aborted) throw new Error("Wait cancelled");
        if (record.promise) await Promise.race([record.promise, new Promise((resolve) => setTimeout(resolve, 25))]);
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return result(recordText(record, params.verbose), { agentId: record.id, status: record.status }, piUsage(record));
    },
  });

  pi.registerTool({
    name: "steer_subagent", label: "Steer Agent", description: "Send a steering message to a running Agent session.", promptSnippet: "Redirect a running Agent",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1, maxLength: 32768 }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) { const { manager } = managerFor(ctx); manager.steer(params.agent_id, params.message); pi.events.emit("subagents:steered", { id: params.agent_id, message: params.message }); return result(`Steering message sent to agent ${params.agent_id}.`); },
  });

  pi.registerCommand("agents", {
    description: "Manage pi-mesh agents and active subagents",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { console.error("The /agents command requires a dialog UI."); return; }
      const { manager, trusted, root } = managerFor(ctx);
      const agents = discoverAgents(root, { scope: "all", includeProject: trusted, projectRoot: root });
      const running = manager.list();
      const scheduler = schedulers.get(`${root}\0${ctx.sessionManager.getSessionId()}`);
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
    if (!ctx.hasUI) return;
    const { manager, key } = managerFor(ctx);
    fleet.bind(ctx, manager, key);
  });

  pi.registerShortcut("ctrl+shift+a", {
    description: "Open the pi-mesh agent fleet",
    handler: async (ctx) => { const { manager } = managerFor(ctx); await fleet.select(ctx, manager); },
  });

  const unregisterRpc = registerSubagentRpc(pi, managerFor);
  return async () => { unregisterRpc(); fleet.dispose(); for (const scheduler of schedulers.values()) scheduler.dispose(); schedulers.clear(); await Promise.allSettled([...managers.values()].map(({ manager }) => manager.shutdown())); for (const { notifier } of managers.values()) notifier.dispose(); managers.clear(); };
}
