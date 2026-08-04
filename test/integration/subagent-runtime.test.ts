import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../src/agents.ts";
import { defaultMeshSettings } from "../../src/settings.ts";
import { SubagentRuntime } from "../../src/subagent-runtime.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", promptMode: "replace", source: "bundled", filePath: "worker.md" };

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
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null });
    modelRuntime.registerProvider("runtime-only", {
      name: "Runtime only", baseUrl: "file://runtime-only", apiKey: "mock", api: "openai-completions",
      models: [{ id: "model-1", name: "Model 1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
      streamSimple(model: Model<any>, context: Context, _options?: SimpleStreamOptions) {
        seen = context;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "IN_PROCESS_TEST_OK" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: { ...message, content: [] } });
          stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "IN_PROCESS_TEST_OK", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "IN_PROCESS_TEST_OK", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const runtime = new SubagentRuntime(defaultMeshSettings, { modelRegistry });
    const selectedAgent = { ...agent, model: "runtime-only/model-1" };
    const sessionDir = path.join(root, "sessions");
    const execution = runtime.start(selectedAgent, { id: "in-process", cwd: root, prompt: "test", persistent: true, sessionDir });
    const result = await execution.completion;
    assert.equal(result.output, "IN_PROCESS_TEST_OK");
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
