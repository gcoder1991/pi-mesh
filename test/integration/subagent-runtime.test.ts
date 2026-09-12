import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../src/agents.ts";
import { defaultMeshSettings } from "../../src/settings.ts";
import { SubagentRuntime } from "../../src/subagent-runtime.ts";
import { growthPrompt, PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", promptMode: "replace", source: "bundled", filePath: "worker.md" };

test("growth guidance names the node allowlist", () => {
  assert.match(growthPrompt({ ...agent, allowedSubagents: ["reviewer", "qa"] }, true), /Allowed agents: reviewer, qa/);
  assert.match(growthPrompt({ ...agent, allowedSubagents: ["reviewer", "qa"] }, true), /mesh_control status/);
  assert.match(growthPrompt(agent, false), /Do not create or manage child agents/);
});

async function fixture(fn: (root: string, queue: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-runtime-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-runtime-queue-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try { await fn(root, queue); } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true });
  }
}

function response(queue: string, index: number, value: object): void { fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value)); }

test("shared subagent runtime runs, steers, resumes, and preserves conversation", async () => fixture(async (root, queue) => {
  response(queue, 1, { output: "first", delay: 50 });
  const runtime = new SubagentRuntime(defaultMeshSettings);
  const execution = runtime.start(agent, { id: "session", cwd: root, prompt: "first", persistent: true });
  setTimeout(() => execution.steer("focus"), 10);
  const first = await execution.completion;
  assert.equal(first.output, "first");
  response(queue, 2, { output: "second" });
  const second = await execution.session.prompt("second");
  assert.equal(second.output, "second");
  assert.match(execution.conversation(), /first[\s\S]*second/);
  await execution.close();
  const calls = fs.readdirSync(queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(queue, name), "utf8")));
  assert.ok(calls[0].args.includes("--session-id"));
  assert.equal(calls[0].args.some((value: string) => value.endsWith("control-extension.ts")), false);
  assert.ok(calls[0].args.includes("--no-context-files"));
}));

test("child RPC fails closed on interactive extension UI requests", async () => fixture(async (root, queue) => {
  response(queue, 1, { output: "continued", uiRequest: true });
  const execution = new SubagentRuntime(defaultMeshSettings).start(agent, { id: "ui", cwd: root, prompt: "ui" });
  assert.equal((await execution.completion).output, "continued");
  await execution.close();
  const responseFile = fs.readdirSync(queue).find((name) => name.startsWith("ui-response-"));
  assert.ok(responseFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(queue, responseFile!), "utf8")), { type: "extension_ui_response", id: "ui-1", cancelled: true });
}));
test("child extension and skill resources require named settings allowlists", async () => fixture(async (root, queue) => {
  const restricted = { ...agent, extensions: ["mcp"], skills: ["browser"] };
  assert.throws(() => new SubagentRuntime(defaultMeshSettings).start(restricted, { id: "blocked", cwd: root, prompt: "x" }), /Unapproved child resources/);
  const extension = path.join(root, "mcp.ts"), skill = path.join(root, "SKILL.md"); fs.writeFileSync(extension, "export default () => {}\n"); fs.writeFileSync(skill, "---\nname: browser\ndescription: browser\n---\n");
  response(queue, 1, { output: "ok" });
  const runtime = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { mcp: extension }, childSkills: { browser: skill } });
  const execution = runtime.start(restricted, { id: "allowed", cwd: root, prompt: "ok" });
  assert.equal((await execution.completion).output, "ok"); await execution.close();
  const call = JSON.parse(fs.readFileSync(path.join(queue, fs.readdirSync(queue).find((name) => name.startsWith("call-"))!), "utf8"));
  assert.ok(call.args.includes(extension)); assert.ok(call.args.includes(skill));
}));

test("in-process AgentSession reuses a runtime-only Host provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-in-process-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV];
  delete process.env[PI_MESH_PI_BINARY_ENV];
  let seen: Context | undefined;
  let calls = 0;
  try {
    fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    modelRuntime.registerProvider("runtime-only", {
      name: "Runtime only", baseUrl: "file://runtime-only", apiKey: "mock", api: "openai-completions",
      models: [{ id: "model-1", name: "Model 1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
      streamSimple(model: Model<any>, context: Context, _options?: SimpleStreamOptions) {
        seen = context;
        calls++;
        const stream = createAssistantMessageEventStream();
        const retrying = calls === 1;
        const message: AssistantMessage = { role: "assistant", content: retrying ? [] : [{ type: "text", text: "IN_PROCESS_TEST_OK" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: retrying ? "error" : "stop", timestamp: Date.now(), ...(retrying ? { errorMessage: "500: internal_server_error" } : {}) };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: { ...message, content: [] } });
          if (retrying) stream.push({ type: "error", reason: "error", error: message });
          else {
            stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "IN_PROCESS_TEST_OK", partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: "IN_PROCESS_TEST_OK", partial: message });
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
        });
        return stream;
      },
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const runtime = new SubagentRuntime(defaultMeshSettings, { modelRegistry, projectTrusted: true });
    const selectedAgent = { ...agent, model: "runtime-only/model-1" };
    const sessionDir = path.join(root, "sessions");
    const execution = runtime.start(selectedAgent, { id: "in-process", cwd: root, prompt: "test", persistent: true, sessionDir });
    const result = await execution.completion;
    assert.equal(calls, 2);
    assert.equal(result.output, "IN_PROCESS_TEST_OK");
    assert.equal(result.error, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.model, "runtime-only/model-1");
    assert.match(seen?.systemPrompt ?? "", /work/);
    assert.deepEqual(seen?.tools?.map((tool) => tool.name), ["read"]);
    const sessionFile = execution.sessionFile;
    assert.ok(sessionFile);
    await execution.close();
    const resumed = runtime.connect(selectedAgent, { id: "in-process", cwd: root, prompt: "unused", persistent: true, sessionDir, sessionFile });
    assert.equal((await resumed.session.prompt("resume")).output, "IN_PROCESS_TEST_OK");
    assert.ok(seen?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Task: test")));
    await resumed.close();
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// All providers below are local deterministic streams. Even the package resolver
// guard fails before delegating if any unapproved source reaches the SDK.
async function sdkFixture(fn: (root: string, modelRegistry: ModelRegistry, state: { calls: number; contexts: Context[]; respond: (model: Model<any>, context: Context, call: number) => Partial<AssistantMessage>; delay: number }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-runtime-sdk-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV];
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-dir");
  delete process.env[PI_MESH_PI_BINARY_ENV];
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const state = { calls: 0, contexts: [] as Context[], respond: (_model: Model<any>, _context: Context, _call: number): Partial<AssistantMessage> => ({ content: [{ type: "text", text: "LOCAL_OK" }] }), delay: 0 };
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    runtime.registerProvider("local-runtime", {
      name: "Local", baseUrl: "file://local", apiKey: "in-memory-secret", api: "openai-completions",
      models: [{ id: "test", name: "Local test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
      streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
        state.contexts.push(context);
        const next = state.respond(model, context, ++state.calls);
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(), ...next };
        const finish = () => {
          options?.signal?.removeEventListener("abort", abort);
          if (options?.signal?.aborted) { message.stopReason = "aborted"; message.errorMessage = "mock aborted"; }
          stream.push({ type: "start", partial: { ...message, content: [] } });
          if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
          else stream.push({ type: "done", reason: message.stopReason === "pending" ? "stop" : message.stopReason, message });
          stream.end();
        };
        const timer = setTimeout(finish, state.delay);
        const abort = () => { clearTimeout(timer); finish(); };
        options?.signal?.addEventListener("abort", abort, { once: true });
        return stream;
      },
    });
    await fn(root, new ModelRegistry(runtime), state);
    assert.equal(fs.existsSync(path.join(root, "auth.json")), false, "Host runtime credentials must remain in memory");
    assert.equal(fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR, "auth.json")), false);
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const localAgent = { ...agent, model: "local-runtime/test" };

function probeExtension(root: string): { file: string; probe: any; cleanup: () => void } {
  const key = `runtime-probe:${root}`;
  const probe: any = { identities: [], starts: 0, shutdowns: 0, validAtShutdown: false };
  (globalThis as any)[key] = probe;
  const file = path.join(root, "probe.mjs");
  fs.writeFileSync(file, `export default (pi) => {
    const probe = globalThis[${JSON.stringify(key)}];
    probe.events = pi.events;
    pi.on('session_start', () => {
      probe.starts++;
      let replied = false;
      pi.events.emit('pi-mesh:runtime:identity:query', {version:1, reply: identity => { probe.identities.push(identity); replied = true; }});
      probe.synchronous = replied;
    });
    pi.on('session_shutdown', async () => {
      probe.shutdowns++;
      probe.validAtShutdown = Array.isArray(pi.getActiveTools());
      if (probe.gate) await probe.gate;
      probe.finished = true;
    });
  };`);
  return { file, probe, cleanup: () => { delete (globalThis as any)[key]; } };
}

test("untrusted shell/context and global+project default packages cannot reactivate; approved resources stay usable", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
  const originalResolve = DefaultPackageManager.prototype.resolve;
  let resolves = 0;
  DefaultPackageManager.prototype.resolve = async function (...args) {
    const settings = (this as any).settingsManager;
    for (const scope of [settings.getGlobalSettings(), settings.getProjectSettings()]) {
      for (const kind of ["packages", "extensions", "skills", "prompts", "themes"]) assert.deepEqual(scope[kind] ?? [], [], `default ${kind} must be removed before SDK resolution`);
    }
    resolves++;
    return originalResolve.apply(this, args);
  };
  const extension = probeExtension(root);
  try {
    const project = path.join(root, ".pi"); fs.mkdirSync(project);
    const marker = path.join(root, "UNTRUSTED_EXECUTED");
    const unwanted = path.join(root, "unwanted.mjs");
    fs.writeFileSync(unwanted, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default () => {};`);
    const defaults = { packages: ["npm:must-never-install-runtime-test"], extensions: [unwanted], skills: [], prompts: [], themes: [], retry: { enabled: false } };
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify(defaults));
    fs.writeFileSync(path.join(project, "settings.json"), JSON.stringify({ ...defaults, shellPath: "/does/not/exist", shellCommandPrefix: `touch ${marker};` }));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "UNTRUSTED_PROJECT_AGENTS");
    const skill = path.join(root, "approved", "SKILL.md"); fs.mkdirSync(path.dirname(skill));
    fs.writeFileSync(skill, "---\nname: approved-skill\ndescription: APPROVED_SKILL_DESCRIPTION\n---\nApproved local instructions\n");
    state.respond = (_model, _context, call) => call === 1 ? { content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "printf TRUST_SAFE" } }], stopReason: "toolUse" } : { content: [{ type: "text", text: "SAFE" }] };
    const runtime = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { probe: extension.file }, childSkills: { approved: skill } }, { modelRegistry });
    const execution = runtime.start({ ...localAgent, promptMode: "append", tools: ["bash", "read"], extensions: ["probe"], skills: ["approved"] }, { id: "trust", cwd: root, prompt: "run the safe local command", mesh: { root, runId: "run", nodeId: "node", attempt: 2 } });
    try {
      assert.equal((await execution.completion).output, "SAFE");
      assert.equal(fs.existsSync(marker), false);
      assert.ok(resolves > 0);
      assert.match(state.contexts[0]?.systemPrompt ?? "", /APPROVED_SKILL_DESCRIPTION/);
      assert.doesNotMatch(state.contexts[0]?.systemPrompt ?? "", /UNTRUSTED_PROJECT_AGENTS/);
      assert.ok(state.contexts[1]?.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("TRUST_SAFE")));
      assert.ok(state.contexts[0]?.tools?.some((tool) => tool.name === "mesh_control"));
      assert.equal(extension.probe.synchronous, true);
      assert.deepEqual(extension.probe.identities, [{ version: 1, managed: true, agentId: "trust", runId: "run", nodeId: "node", attempt: 2 }]);
      assert.ok(Object.isFrozen(extension.probe.identities[0]));
    } finally { await execution.close(); }
  } finally { DefaultPackageManager.prototype.resolve = originalResolve; extension.cleanup(); }
}));

test("approved extension packages and resources_discover do not grant extra skills/prompts/themes", async () => sdkFixture(async (root, modelRegistry, state) => {
  const pkg = path.join(root, "package"); fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "local-approved-extension", pi: { extensions: ["index.mjs"], skills: ["SKILL.md"], prompts: ["prompt.md"] } }));
  fs.writeFileSync(path.join(pkg, "SKILL.md"), "---\nname: not-approved\ndescription: UNAPPROVED_SIDECAR\n---\nno\n");
  fs.writeFileSync(path.join(pkg, "prompt.md"), "UNAPPROVED_PROMPT");
  fs.writeFileSync(path.join(pkg, "index.mjs"), `export default pi => { pi.on('resources_discover', () => ({skillPaths:[${JSON.stringify(path.join(pkg, "SKILL.md"))}], promptPaths:[${JSON.stringify(path.join(pkg, "prompt.md"))}]})); };`);
  const execution = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { local: pkg } }, { modelRegistry }).start({ ...localAgent, extensions: ["local"] }, { id: "sidecar", cwd: root, prompt: "/prompt" });
  try {
    assert.equal((await execution.completion).stopReason, "completed");
    assert.doesNotMatch(JSON.stringify(state.contexts), /UNAPPROVED_SIDECAR|UNAPPROVED_PROMPT/);
  } finally { await execution.close(); }
}));

test("ready is awaited before prompting; fresh session path is recorded before SDK header flush and genuinely resumes", async () => sdkFixture(async (root, modelRegistry, state) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let recorded: string | undefined;
  const runtime = new SubagentRuntime(defaultMeshSettings, { modelRegistry });
  const execution = runtime.start(localAgent, { id: "ready", cwd: root, prompt: "FIRST_TASK", persistent: true, onReady: async (ready) => { recorded = ready.sessionFile; assert.equal(ready.persisted, false); assert.equal(fs.existsSync(recorded!), false); await gate; } });
  try {
    while (!recorded) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(state.calls, 0);
    assert.throws(() => runtime.connect(localAgent, { id: "early", cwd: root, prompt: "resume", sessionFile: recorded }), /Cannot resume child session.*ENOENT/);
    release();
    assert.equal((await execution.ready).sessionFile, recorded);
    assert.equal((await execution.completion).partial, false);
    assert.ok(fs.existsSync(recorded!));
    const header = JSON.parse(fs.readFileSync(recorded!, "utf8").split("\n")[0]!);
    assert.equal(header.type, "session");
    await execution.close();
    const resumed = runtime.connect(localAgent, { id: "resume", cwd: root, prompt: "unused", sessionFile: recorded });
    try {
      assert.equal((await resumed.ready).persisted, true);
      assert.equal(resumed.sessionFile, recorded);
      assert.equal((await resumed.session.prompt("SECOND_TASK")).stopReason, "completed");
      assert.match(JSON.stringify(state.contexts.at(-1)?.messages), /FIRST_TASK/);
      assert.equal(JSON.parse(fs.readFileSync(recorded!, "utf8").split("\n")[0]!).id, header.id);
    } finally { await resumed.close(); }
  } finally { release(); await execution.close(); }
}));

test("connect and start reject missing, empty, corrupt, symlink and escaped session evidence without creating files", async () => sdkFixture(async (root, modelRegistry) => {
  const dir = path.join(root, ".pi", "mesh", "sessions"); fs.mkdirSync(dir, { recursive: true });
  const empty = path.join(dir, "empty.jsonl"); fs.writeFileSync(empty, "");
  const corrupt = path.join(dir, "corrupt.jsonl"); fs.writeFileSync(corrupt, "{}\n");
  const outside = path.join(root, "outside.jsonl"); fs.writeFileSync(outside, '{"type":"session","id":"outside"}\n');
  const link = path.join(dir, "link.jsonl"); fs.symlinkSync(outside, link);
  const runtime = new SubagentRuntime(defaultMeshSettings, { modelRegistry });
  for (const file of [path.join(dir, "missing.jsonl"), empty, corrupt, outside, link]) {
    for (const method of ["connect", "start"] as const) assert.throws(() => runtime[method](localAgent, { id: "invalid", cwd: root, prompt: "resume", sessionFile: file }), /Cannot resume child session.*Restore the original session file/);
  }
  assert.equal(fs.readFileSync(empty, "utf8"), "");
  assert.equal(fs.existsSync(path.join(dir, "missing.jsonl")), false);
}));

test("real SDK shutdown occurs once before API invalidation; concurrent close waits and identity stays child-local", async () => sdkFixture(async (root, modelRegistry) => {
  const { createEventBus } = await import("@earendil-works/pi-coding-agent");
  const extension = probeExtension(root);
  let release!: () => void;
  extension.probe.gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { probe: extension.file } }, { modelRegistry });
  const execution = runtime.start({ ...localAgent, extensions: ["probe"] }, { id: "identity-child", cwd: root, prompt: "hello" });
  try {
    await execution.completion;
    let hostReplies = 0;
    createEventBus().emit("pi-mesh:runtime:identity:query", { version: 1, reply: () => { hostReplies++; } });
    assert.equal(hostReplies, 0);
    assert.deepEqual(extension.probe.identities, [{ version: 1, managed: true, agentId: "identity-child" }]);
    const first = execution.close(), second = execution.close();
    assert.strictEqual(first, second);
    let closed = false; void second.then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(extension.probe.shutdowns, 1);
    assert.equal(extension.probe.validAtShutdown, true);
    assert.equal(closed, false);
    release(); await Promise.all([first, second]);
    assert.equal(extension.probe.finished, true);
    let replies = 0;
    try { extension.probe.events.emit("pi-mesh:runtime:identity:query", { version: 1, reply: () => { replies++; } }); }
    catch (error) {
      // 0.83 permits a silent emit on the detached bus; 0.84 rejects the captured
      // API facade. Both must fail closed, never mask any other exception.
      assert.ok(error instanceof Error);
      assert.equal(error.message, "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().");
    }
    assert.equal(replies, 0);
    await execution.close();
    assert.equal(extension.probe.shutdowns, 1);
  } finally { release(); await execution.close(); extension.cleanup(); }
}));

test("binding and onReady failures finalize created SDK sessions and subscriptions", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const originalBind = AgentSession.prototype.bindExtensions;
  const originalDispose = AgentSession.prototype.dispose;
  const originalSubscribe = AgentSession.prototype.subscribe;
  const extension = probeExtension(root);
  let disposed = 0, subscriptions = 0;
  AgentSession.prototype.subscribe = function (...args) { subscriptions++; const off = originalSubscribe.apply(this, args); return () => { subscriptions--; off(); }; };
  AgentSession.prototype.dispose = function () { disposed++; assert.equal(extension.probe.validAtShutdown, true); originalDispose.call(this); };
  const runtime = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { probe: extension.file } }, { modelRegistry });
  try {
    AgentSession.prototype.bindExtensions = async function (...args) { await originalBind.apply(this, args); throw new Error("injected bind failure"); };
    const binding = runtime.start({ ...localAgent, extensions: ["probe"] }, { id: "bind", cwd: root, prompt: "no" });
    await assert.rejects(binding.ready, /injected bind failure/);
    assert.equal((await binding.completion).stopReason, "error");
    await binding.close();
    AgentSession.prototype.bindExtensions = originalBind;
    const callback = runtime.connect({ ...localAgent, extensions: ["probe"] }, { id: "callback", cwd: root, prompt: "no", onReady: () => { throw new Error("injected ready failure"); } });
    await assert.rejects(callback.ready, /injected ready failure/);
    await callback.close();
    assert.equal(disposed, 2); assert.equal(subscriptions, 0); assert.equal(extension.probe.shutdowns, 2); assert.equal(state.calls, 0);
  } finally { AgentSession.prototype.bindExtensions = originalBind; AgentSession.prototype.dispose = originalDispose; AgentSession.prototype.subscribe = originalSubscribe; extension.cleanup(); }
}));

for (const hard of [false, true]) test(`maxTurns ${hard ? "hard abort" : "soft wrap-up"} reports partial/maxTurns`, async () => sdkFixture(async (root, modelRegistry, state) => {
  fs.writeFileSync(path.join(root, "input.txt"), "local input");
  state.respond = (_model, _context, call) => hard || call === 1 ? { content: [{ type: "text", text: `partial-${call}` }, { type: "toolCall", id: `read-${call}`, name: "read", arguments: { path: "input.txt" } }], stopReason: "toolUse" } : { content: [{ type: "text", text: "wrapped up" }] };
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry }).start(localAgent, { id: "limit", cwd: root, prompt: "bounded", maxTurns: 1 });
  try {
    const result = await execution.completion;
    assert.equal(result.stopReason, "maxTurns"); assert.equal(result.partial, true);
    assert.equal(result.exitCode, hard ? 1 : 0);
    assert.ok(result.output);
    assert.equal(state.calls, hard ? 6 : 2);
    assert.match(JSON.stringify(state.contexts.at(-1)?.messages), /Wrap up immediately/);
    if (hard) assert.match(result.error ?? "", /maxTurns wrap-up allowance/);
  } finally { await execution.close(); }
}));

for (const reason of ["cancelled", "timeout", "error"] as const) test(`${reason} preserves partial output and stopReason`, async () => sdkFixture(async (root, modelRegistry, state) => {
  state.delay = reason === "error" ? 0 : 100;
  state.respond = () => ({ content: [{ type: "text", text: "partial evidence" }], ...(reason === "error" ? { stopReason: "error", errorMessage: "local provider failure" } : {}) });
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry }).start(localAgent, { id: reason, cwd: root, prompt: "bounded", ...(reason === "timeout" ? { timeoutMs: 10 } : {}) });
  try {
    await execution.ready;
    if (reason === "cancelled") { while (!state.calls) await new Promise((resolve) => setTimeout(resolve, 1)); execution.abort(); }
    const result = await execution.completion;
    assert.equal(result.stopReason, reason); assert.equal(result.partial, true); assert.equal(result.exitCode, 1);
    assert.equal(result.output, "partial evidence");
  } finally { await execution.close(); }
}));

test("conversation/output and constructed prompts are bounded UTF-8 with artifact evidence", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } = await import("@earendil-works/pi-coding-agent");
  const { MAX_SUBAGENT_PROMPT_BYTES } = await import("../../src/subagent-runtime.ts");
  const text = "证据🙂".repeat(150000) + "NEWEST_END";
  state.respond = () => ({ content: [{ type: "text", text }] });
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry }).start({ ...localAgent, systemPrompt: "系统🙂".repeat(50000) }, { id: "utf8", cwd: root, prompt: "任务🙂".repeat(100000), parentContext: "父上下文🙂".repeat(100000) });
  try {
    const result = await execution.completion;
    assert.equal(result.outputTruncated, true); assert.equal(result.promptTruncated, true);
    assert.ok(result.output);
    assert.ok(Buffer.byteLength(result.output) <= DEFAULT_MAX_BYTES);
    assert.doesNotMatch(result.output, /\uFFFD/);
    assert.equal(fs.readFileSync(result.outputPath!, "utf8"), text);
    const snapshot = execution.conversationSnapshot();
    assert.equal(snapshot.truncated, true); assert.ok(snapshot.artifactPath);
    assert.ok(Buffer.byteLength(snapshot.text) <= DEFAULT_MAX_BYTES);
    assert.ok(snapshot.text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.match(snapshot.text, /truncated conversation/); assert.match(snapshot.text, /NEWEST_END$/); assert.doesNotMatch(snapshot.text, /\uFFFD/);
    const context = state.contexts[0]!;
    assert.ok(Buffer.byteLength(context.systemPrompt ?? "") + Buffer.byteLength(JSON.stringify(context.messages)) <= MAX_SUBAGENT_PROMPT_BYTES);
    assert.match(context.systemPrompt ?? "", /Do not create or manage child agents/);
  } finally { await execution.close(); }
}));

test("close during initialization and in-flight prompt drains before finalization", async () => sdkFixture(async (root, modelRegistry, state) => {
  const runtime = new SubagentRuntime(defaultMeshSettings, { modelRegistry });
  const early = runtime.start(localAgent, { id: "early-close", cwd: root, prompt: "never start" });
  const closing = early.close();
  assert.strictEqual(early.close(), closing);
  assert.equal((await early.completion).stopReason, "cancelled");
  await closing;
  assert.equal(state.calls, 0);
  state.delay = 100;
  const running = runtime.start(localAgent, { id: "running-close", cwd: root, prompt: "abort while streaming" });
  await running.ready;
  while (!state.calls) await new Promise((resolve) => setTimeout(resolve, 1));
  await running.close();
  assert.equal((await running.completion).stopReason, "cancelled");
  await assert.rejects(running.session.prompt("closed"), /session is closed/);
}));

test("same-PID children answer only on their own bus and reject malformed identity queries", async () => sdkFixture(async (root, modelRegistry) => {
  const first = probeExtension(root);
  const other = path.join(root, "other"); fs.mkdirSync(other);
  const second = probeExtension(other);
  const runtime = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { first: first.file, second: second.file } }, { modelRegistry });
  const a = runtime.connect({ ...localAgent, extensions: ["first"] }, { id: "a", cwd: root, prompt: "unused" });
  const b = runtime.connect({ ...localAgent, extensions: ["second"] }, { id: "b", cwd: root, prompt: "unused" });
  try {
    await Promise.all([a.ready, b.ready]);
    for (const [probe, id] of [[first.probe, "a"], [second.probe, "b"]] as const) {
      const responses: any[] = [];
      probe.events.emit("pi-mesh:runtime:identity:query", { version: 0, reply: (value: any) => responses.push(value) });
      probe.events.emit("pi-mesh:runtime:identity:query", undefined);
      probe.events.emit("pi-mesh:runtime:identity:query", { version: 1, reply: null });
      assert.equal(responses.length, 0);
      probe.events.emit("pi-mesh:runtime:identity:query", { version: 1, reply: (value: any) => responses.push(value) });
      assert.deepEqual(responses, [{ version: 1, managed: true, agentId: id }]);
    }
  } finally { await Promise.all([a.close(), b.close()]); first.cleanup(); second.cleanup(); }
}));

test("trusted append AGENTS and many-line conversation still obey total and display budgets", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } = await import("@earendil-works/pi-coding-agent");
  const { MAX_SUBAGENT_PROMPT_BYTES } = await import("../../src/subagent-runtime.ts");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "TRUSTED_CONTEXT🙂".repeat(60000));
  state.respond = () => ({ content: [{ type: "text", text: "行🙂\n".repeat(4000) + "LATEST_LINE" }] });
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry, projectTrusted: true }).start({ ...localAgent, promptMode: "append" }, { id: "lines", cwd: root, prompt: "task", parentContext: "context".repeat(30000) });
  try {
    const result = await execution.completion;
    assert.equal(result.promptTruncated, true);
    const context = state.contexts[0]!;
    assert.match(context.systemPrompt ?? "", /TRUSTED_CONTEXT/);
    assert.ok(Buffer.byteLength(context.systemPrompt ?? "") + Buffer.byteLength(JSON.stringify(context.messages)) <= MAX_SUBAGENT_PROMPT_BYTES);
    const snapshot = execution.conversationSnapshot();
    assert.equal(snapshot.truncated, true);
    assert.ok(Buffer.byteLength(snapshot.text) <= DEFAULT_MAX_BYTES);
    assert.ok(snapshot.text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.match(snapshot.text, /LATEST_LINE$/);
    assert.doesNotMatch(snapshot.text, /\uFFFD/);
  } finally { await execution.close(); }
}));

test("failed artifact preflight cannot spawn the legacy hook or leak its temporary prompt", async () => fixture(async (root, queue) => {
  const marker = path.join(root, "not-a-directory"); fs.writeFileSync(marker, "file");
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-mesh-"));
  assert.throws(() => new SubagentRuntime(defaultMeshSettings).start(agent, { id: "preflight", cwd: root, prompt: "never spawn", transcriptPath: path.join(marker, "conversation.jsonl") }), /ENOTDIR|EEXIST/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-mesh-")), before);
  assert.deepEqual(fs.readdirSync(queue), []);
}));

test("artifact write failure remains an explicit partial error instead of losing the result", async () => sdkFixture(async (root, modelRegistry, state) => {
  const dir = path.join(root, "artifacts");
  state.respond = () => {
    fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, "blocked");
    return { content: [{ type: "text", text: "partial".repeat(10000) }] };
  };
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry }).start(localAgent, { id: "artifact-failure", cwd: root, prompt: "output", transcriptPath: path.join(dir, "conversation.jsonl") });
  try {
    const result = await execution.completion;
    assert.equal(result.partial, true); assert.equal(result.stopReason, "error"); assert.equal(result.exitCode, 1);
    assert.equal(result.outputTruncated, true); assert.equal(result.outputPath, undefined); assert.ok(result.output);
    assert.match(result.error ?? "", /Cannot preserve full child output.*permissions and disk space/);
  } finally { await execution.close(); }
}));

test("provider-entry guard stops retry first turns at maxTurns+5 and restores public callbacks", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 10, baseDelayMs: 1, maxDelayMs: 1 } }));
  const bind = AgentSession.prototype.bindExtensions;
  let active: any, stream: any, prepare: any;
  AgentSession.prototype.bindExtensions = async function (...args) { await bind.apply(this, args); active = this.agent; stream = active.streamFunction; prepare = active.prepareNextTurnWithContext; };
  state.respond = () => ({ content: [], stopReason: "error", errorMessage: "500 internal_server_error retryable" });
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry }).start(localAgent, { id: "retry-guard", cwd: root, prompt: "retry", maxTurns: 1 });
  try {
    const result = await execution.completion;
    assert.equal(state.calls, 6); assert.equal(result.stopReason, "maxTurns"); assert.equal(result.partial, true);
    assert.equal(active.streamFunction, stream); assert.equal(active.prepareNextTurnWithContext, prepare);
  } finally { await execution.close(); AgentSession.prototype.bindExtensions = bind; }
}));

test("cancel during async before_agent_start never enters provider and restores stream callback", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const key = `preflight-gate:${root}`; let release!: () => void;
  const probe = { gate: new Promise<void>((resolve) => { release = resolve; }), entered: false }; (globalThis as any)[key] = probe;
  const file = path.join(root, "gate.mjs"); fs.writeFileSync(file, `export default pi => pi.on('before_agent_start', async () => { const p = globalThis[${JSON.stringify(key)}]; p.entered = true; await p.gate; });`);
  const bind = AgentSession.prototype.bindExtensions; let active: any, stream: any, prepare: any;
  AgentSession.prototype.bindExtensions = async function (...args) { await bind.apply(this, args); active = this.agent; stream = active.streamFunction; prepare = active.prepareNextTurnWithContext; };
  const execution = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { gate: file } }, { modelRegistry }).start({ ...localAgent, extensions: ["gate"] }, { id: "preflight", cwd: root, prompt: "never" });
  try {
    while (!probe.entered) await new Promise((resolve) => setTimeout(resolve, 1));
    execution.abort(); release(); const result = await execution.completion;
    assert.equal(state.calls, 0); assert.equal(result.stopReason, "cancelled");
    assert.equal(active.streamFunction, stream); assert.equal(active.prepareNextTurnWithContext, prepare);
  } finally { release(); await execution.close(); AgentSession.prototype.bindExtensions = bind; delete (globalThis as any)[key]; }
}));

test("a successful factory is shut down once when a sibling fails before session creation", async () => sdkFixture(async (root, modelRegistry, state) => {
  const key = `partial-load:${root}`; const probe = { ticks: 0, starts: 0, stops: 0, timer: undefined as NodeJS.Timeout | undefined }; (globalThis as any)[key] = probe;
  const a = path.join(root, "a.mjs"), b = path.join(root, "b.mjs");
  fs.writeFileSync(a, `export default pi => { const p = globalThis[${JSON.stringify(key)}]; p.timer = setInterval(() => p.ticks++, 2); pi.on('session_start', () => p.starts++); pi.on('session_shutdown', () => { p.stops++; clearInterval(p.timer); }); };`);
  fs.writeFileSync(b, "export default () => { throw new Error('sibling factory failed'); };");
  const execution = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { a, b } }, { modelRegistry }).start({ ...localAgent, extensions: ["a", "b"] }, { id: "factory-failure", cwd: root, prompt: "never" });
  try {
    await assert.rejects(execution.ready, /sibling factory failed/); await execution.completion;
    await Promise.all([execution.close(), execution.close()]);
    assert.equal(probe.stops, 1); assert.equal(probe.starts, 0); assert.equal(state.calls, 0);
    const ticks = probe.ticks; await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(probe.ticks, ticks);
  } finally { await execution.close(); clearInterval(probe.timer); delete (globalThis as any)[key]; }
}));

test("conversation multi-part budgets retain 40KiB without silent loss and truncate emoji tails explicitly", async () => sdkFixture(async (root, modelRegistry, state) => {
  state.respond = () => ({ content: [{ type: "text", text: "A".repeat(10 * 1024) }, { type: "text", text: "B".repeat(30 * 1024) }] });
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry }).start(localAgent, { id: "parts", cwd: root, prompt: "short" });
  try {
    await execution.completion;
    const snapshot = execution.conversationSnapshot(); assert.equal(snapshot.truncated, false);
    assert.ok(snapshot.text.includes("A".repeat(10 * 1024) + "\n" + "B".repeat(30 * 1024)));
    state.respond = () => ({ content: [{ type: "text", text: "🙂".repeat(20000) }, { type: "text", text: "TAIL🙂".repeat(5000) }] });
    await execution.session.prompt("overflow"); const tail = execution.conversationSnapshot();
    assert.equal(tail.truncated, true); assert.match(tail.text, /TAIL🙂$/); assert.doesNotMatch(tail.text, /\uFFFD/); assert.ok(Buffer.byteLength(tail.text) <= 50 * 1024);
  } finally { await execution.close(); }
}));

test("large SYSTEM and APPEND_SYSTEM retain managed role and mandatory growth instructions", async () => sdkFixture(async (root, modelRegistry, state) => {
  const dir = path.join(root, ".pi"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "SYSTEM.md"), "BASE".repeat(100000));
  fs.writeFileSync(path.join(dir, "APPEND_SYSTEM.md"), "APPEND".repeat(100000));
  const execution = new SubagentRuntime(defaultMeshSettings, { modelRegistry, projectTrusted: true }).start({ ...localAgent, promptMode: "append", systemPrompt: "ROLE_SENTINEL_DIRECT_TEST" }, { id: "large-role", cwd: root, prompt: "check" });
  try {
    const result = await execution.completion; const system = state.contexts[0]!.systemPrompt!;
    assert.match(system, /ROLE_SENTINEL_DIRECT_TEST/); assert.match(system, /Do not create or manage child agents/);
    assert.ok(Buffer.byteLength(system) <= 64 * 1024); assert.equal(result.promptTruncated, true);
  } finally { await execution.close(); }
}));

test("bridge review B4 actual approved localMesh path factory is child-local before inline factories; independent Host stays live", async () => sdkFixture(async (root, modelRegistry, state) => {
  const { DefaultResourceLoader, createAgentSession, SettingsManager, SessionManager, createEventBus } = await import('@earendil-works/pi-coding-agent');
  const { sessionFleetLimiter } = await import('../../src/fleet-limiter.ts');
  const meshPath = path.resolve('index.ts'), observer = probeExtension(root), hostBus = createEventBus();
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const hostLoader = new DefaultResourceLoader({ cwd: root, eventBus: hostBus, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager, noExtensions: true, additionalExtensionPaths: [meshPath], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await hostLoader.reload(); assert.deepEqual(hostLoader.getExtensions().errors, []);
  const { session: host } = await createAgentSession({ cwd: root, resourceLoader: hostLoader, settingsManager, sessionManager: SessionManager.inMemory(root), modelRuntime: (modelRegistry as any).runtime, model: modelRegistry.find('local-runtime', 'test') });
  await host.bindExtensions({});
  const hostId = host.sessionId, limiter = sessionFleetLimiter(hostId, 2), release = await limiter.acquire();
  const reload = DefaultResourceLoader.prototype.reload; let loaded: any;
  DefaultResourceLoader.prototype.reload = async function() { await reload.call(this); loaded = this.getExtensions(); };
  const execution = new SubagentRuntime({ ...defaultMeshSettings, childExtensions: { localMesh: meshPath, observer: observer.file } }, { modelRegistry, projectTrusted: true }).connect({ ...localAgent, extensions: ['localMesh', 'observer'] }, { id: 'alias-child', cwd: root, prompt: 'not prompted' });
  try {
    await execution.ready;
    const actual = loaded.extensions.find((e: any) => e.path === meshPath || e.resolvedPath === meshPath);
    assert.ok(actual, 'real path factory was loaded, not alias-name rejected');
    assert.equal(actual.tools.size, 0, 'managed child must not register ordinary mesh/Agent tools');
    assert.equal(actual.handlers.size, 0, 'no Host lifecycle, Manager, scheduler or shutdown registrations');
    assert.equal(actual.commands.size, 0);
    let childReplies = 0, hostReplies = 0;
    observer.probe.events.on('subagents:rpc:ping:reply:probe', () => childReplies++);
    hostBus.on('subagents:rpc:ping:reply:probe', () => hostReplies++);
    observer.probe.events.emit('subagents:rpc:ping', { requestId: 'probe' });
    hostBus.emit('subagents:rpc:ping', { requestId: 'probe' });
    assert.equal(childReplies, 0, 'no ordinary child RPC listener'); assert.equal(hostReplies, 1, 'same-PID Host RPC positive control');
    assert.ok(host.extensionRunner.getAllRegisteredTools().some(t => t.definition.name === 'Agent'));
    assert.ok(host.extensionRunner.getAllRegisteredTools().some(t => t.definition.name === 'mesh'));
    await execution.close();
    assert.equal(sessionFleetLimiter(hostId, 2), limiter, 'child shutdown cannot clear live Host Fleet owner');
    assert.equal(limiter.active, 1); assert.equal(state.calls, 0);
    const tool = host.extensionRunner.getAllRegisteredTools().find(t => t.definition.name === 'mesh')!.definition;
    const result: any = await tool.execute('host-positive', { action: 'list' }, undefined, undefined, host.extensionRunner.createContext());
    assert.notEqual(result.isError, true, JSON.stringify(result));
  } finally { DefaultResourceLoader.prototype.reload = reload; await execution.close(); release(); await host.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); host.dispose(); observer.cleanup(); }
}));
