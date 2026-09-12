import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { failDirectorySync } from "../support/atomic-fault.ts";
import { runFile } from "../../src/store.ts";

import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MeshManager } from "../../src/manager.ts";
import { FleetLimiter } from "../../src/fleet-limiter.ts";
import { defaultMeshSettings } from "../../src/settings.ts";
import { discoverAgents } from "../../src/agents.ts";

// Actual SDK 0.83 AgentSessions + deterministic in-memory provider. No RPC
// fixture, credentials, external transport or user session files are involved.
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function until(fn: () => boolean) { for (let n = 0; n < 600 && !fn(); n++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn(), "SDK condition settled"); }
async function fixture(fn: (fx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const fx = await setup(); try { await fn(fx); } finally { await fx.manager.shutdown(); fs.rmSync(fx.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sdk-")));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "agents", "local.md"), "---\ndescription: local\nmodel: mesh-local/test\ntools: read\n---\nDo local work.\n");
  fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const state = { calls: 0, delay: 0, text: "MESH_LOCAL", contexts: [] as Context[] };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  runtime.registerProvider("mesh-local", {
    name: "Local", baseUrl: "file://mesh-local", apiKey: "local-fixture", api: "openai-completions",
    models: [{ id: "test", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
      state.calls++; state.contexts.push(context);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: state.text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      const finish = () => {
        options?.signal?.removeEventListener("abort", abort);
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (options?.signal?.aborted) stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "local aborted" } });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end();
      };
      const timer = setTimeout(finish, state.delay); const abort = () => { clearTimeout(timer); finish(); }; options?.signal?.addEventListener("abort", abort, { once: true });
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime), limiter = new FleetLimiter(1);
  const resolveAgent = () => discoverAgents(root, { projectRoot: root }).find((agent) => agent.name === "local");
  const manager = new MeshManager(resolveAgent, defaultMeshSettings, limiter, registry, "sdk", true);
  return { root, state, manager, limiter, resolveAgent };
}
const tasks = [{ id: "a", agent: "local", task: "first" }, { id: "b", agent: "local", task: "second", dependsOn: ["a"] }];

test("real SDK Mesh ready records actual unflushed session path and continuation reuses genuine evidence", async () => fixture(async ({ root, state, manager }) => {
  state.delay = 200;
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] });
  await until(() => Boolean(manager.list()[0]?.nodes[0]?.sessionFile));
  const run = manager.list()[0]!, node = run.nodes[0]!, file = node.sessionFile!;
  assert.match(file, /sessions\/mesh\/.+\/a\/.+\.jsonl$/); assert.equal(fs.existsSync(file), false);
  manager.cancel(run.id); await pending;
  assert.equal(fs.existsSync(file), true, "actual SDK assistant flush produced original evidence");
  await assert.rejects(async () => manager.retryFailed(run.id), /authorization/i);
  state.delay = 0; await manager.retryFailedFromUser(run.id);
  assert.equal(node.sessionFile, file); assert.equal(node.attempt, 2);
  assert.ok(state.contexts.at(-1)!.messages.some((message) => JSON.stringify(message.content).includes("first")));
}));

test("real SDK Mesh pause-resume drains actual session close before releasing quota or lease", async () => fixture(async ({ root, state, manager, limiter }) => {
  const runtime = (manager as any).subagentRuntime, start = runtime.start.bind(runtime), gate = deferred(); let closes = 0;
  runtime.start = (agent: any, opts: any) => { const ex = start(agent, opts), close = ex.close.bind(ex); ex.close = async () => { closes++; if (closes === 1) await gate.promise; await close(); }; return ex; };
  state.delay = 100;
  const first = manager.start({ cwd: root, tasks, maxConcurrency: 1 }); await until(() => state.calls === 1);
  const run = manager.list()[0]!; manager.pause(run.id); const resumed = manager.resume(run.id);
  await until(() => closes === 1); assert.equal(limiter.active, 1); assert.equal(state.calls, 1); assert.equal(run.status, "paused");
  assert.ok(fs.existsSync(path.join(root, ".pi", "mesh", "leases", run.id, "owner.json")));
  gate.resolve(); await first; await resumed;
  assert.equal(closes, 2); assert.equal(state.calls, 2); assert.equal(limiter.active, 0); assert.equal(run.status, "succeeded");
}));

test("real SDK Mesh timeout aborts with timeout stopReason, partial result blocks dependencies", async () => fixture(async ({ root, state, manager }) => {
  state.delay = 2000;
  const run = await manager.start({ cwd: root, tasks: [{ ...tasks[0]!, timeoutMs: 200 }, tasks[1]!] });
  assert.equal(state.calls, 1); assert.equal(run.nodes[0]?.stopReason, "timeout"); assert.equal(run.nodes[0]?.partial, true);
  assert.equal(run.nodes[0]?.status, "failed"); assert.equal(run.nodes[1]?.status, "skipped");
  const attempt = JSON.parse(fs.readFileSync(run.nodes[0]!.attemptResultPath!, "utf8")); assert.equal(attempt.stopReason, "timeout");
}));

test("real SDK Mesh soft maxTurns never succeeds dependencies and full runtime output remains lossless", async () => fixture(async ({ root, state, manager, resolveAgent }) => {
  state.text = "界".repeat(40000);
  manager.updateAuthorization(defaultMeshSettings, true, () => ({ ...resolveAgent()!, maxTurns: 1 }));
  const run = await manager.start({ cwd: root, tasks }); const node = run.nodes[0]!;
  assert.equal(state.calls, node.attemptUsage?.turns, "only the first node performs the SDK wrap-up turns"); assert.equal(run.nodes[1]?.attempt, 0); assert.equal(run.nodes[1]?.status, "skipped"); assert.equal(node.stopReason, "maxTurns"); assert.equal(node.partial, true); assert.equal(node.status, "failed");
  assert.ok(Buffer.byteLength(node.output!) <= 50 * 1024); assert.ok(node.output!.split("\n").length <= 2000);
  assert.equal(fs.readFileSync(node.outputPath!, "utf8"), state.text); assert.equal(node.outputBytes, Buffer.byteLength(state.text));
}));

test("real SDK Mesh quota wait rechecks current Host authorization and starts zero untrusted provider calls", async () => fixture(async ({ root, state, manager, limiter }) => {
  const release = await limiter.acquire(); const pending = manager.start({ cwd: root, tasks: [tasks[0]!] });
  await until(() => limiter.queued === 1); manager.updateAuthorization(defaultMeshSettings, false); release();
  const run = await pending; assert.equal(state.calls, 0); assert.equal(run.status, "failed"); assert.match(run.nodes[0]!.error!, /authorized/);
}));

test("review actual SDK user cancellation authorization and post-rename claim survive recovery exactly once", async () => fixture(async ({ root, state, manager, resolveAgent }) => {
  state.delay = 1000;
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => state.calls === 1);
  const run = manager.list()[0]!; manager.cancel(run.id, undefined, "user"); await pending;
  await assert.rejects(async () => manager.retryFailed(run.id), /authorization/i); assert.equal(state.calls, 1);
  state.delay = 0; await manager.retryFailedFromUser(run.id); assert.equal(state.calls, 2); assert.equal(run.usage?.input, 6);
  const fault = failDirectorySync((file) => file === runFile(root, run.id));
  try { assert.throws(() => manager.claimUsage(run.id), /fsync/); assert.equal(fault.hits, 1); } finally { fault.restore(); }
  const restored = new MeshManager(resolveAgent, defaultMeshSettings, undefined, undefined, "sdk", true);
  try { restored.recover(root); assert.equal(restored.claimUsage(run.id)?.input, 6); assert.equal(restored.claimUsage(run.id), undefined); restored.recover(root); assert.equal(restored.claimUsage(run.id), undefined); }
  finally { await restored.shutdown(); }
}));
