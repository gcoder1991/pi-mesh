import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { failDirectorySync } from "../support/atomic-fault.ts";

import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../src/agents.ts";
import { FleetLimiter } from "../../src/fleet-limiter.ts";
import { SessionAgentManager } from "../../src/session-agents.ts";
import { defaultMeshSettings } from "../../src/settings.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) { for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(predicate(), "condition must settle"); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

async function fixture(fn: (fx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const fx = await setup();
  try { await fn(fx); } finally { await Promise.all(fx.managers.map((m) => m.shutdown())); fs.rmSync(fx.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-direct-sdk-"));
  const agentFile = path.join(root, ".pi", "agents", "local.md"); fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.writeFileSync(agentFile, "---\ndescription: Local test\nmodel: direct-local/test\npersist_session: true\ntools: read\n---\nPerform the task.\n");
  fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const agent = discoverAgents(root, { projectRoot: root }).find((item) => item.name === "local")!;
  const state = { delay: 0, calls: 0, text: "LOCAL_OK", contexts: [] as Context[] };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  runtime.registerProvider("direct-local", {
    name: "Local", baseUrl: "file://direct-local", apiKey: "local-fixture", api: "openai-completions",
    models: [{ id: "test", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
      state.calls++; state.contexts.push(context);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: state.text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      const finish = () => {
        options?.signal?.removeEventListener("abort", abort);
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (options?.signal?.aborted) stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "local aborted" } });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end();
      };
      const timer = setTimeout(finish, state.delay);
      const abort = () => { clearTimeout(timer); finish(); }; options?.signal?.addEventListener("abort", abort, { once: true });
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime);
  const managers: SessionAgentManager[] = [];
  const manager = (session = "sdk", limiter?: FleetLimiter, enabled = true, trusted = true) => {
    const m = new SessionAgentManager({ ...defaultMeshSettings, directCommunication: enabled }, root, undefined, session, limiter, registry, trusted); managers.push(m); return m;
  };
  return { root, agent, agentFile, state, manager, managers, registry };
}

test("real SDK: early dedicated session path, actual flush, restore and missing-file refusal", async () => fixture(async (fx) => {
  const m = fx.manager(); fx.state.delay = 150;
  const record = m.spawn(fx.agent, "early", "early", fx.root, { persistent: true, sessionDir: path.join(fx.root, "host-sessions") });
  await until(() => Boolean(record.launch?.sessionFile));
  assert.match(record.launch!.sessionFile!, /sessions\/direct\/[^/]+\/.+\/.+\.jsonl$/);
  assert.equal(fs.existsSync(record.launch!.sessionFile!), false, "SDK hasn't flushed its header yet");
  const file = record.launch!.sessionFile!;
  await record.promise; assert.equal(fs.existsSync(file), true); assert.equal(record.execution, undefined);
  const restored = fx.manager(); assert.equal(restored.get(record.id)?.launch?.sessionFile, file);
  fx.state.delay = 0; await restored.resume(record.id, "continue");
  assert.equal(fx.state.calls, 2); assert.equal(restored.get(record.id)?.launch?.sessionFile, file);
  assert.ok(fx.state.contexts[1]!.messages.some((message) => JSON.stringify(message.content).includes("early")));
  fs.unlinkSync(file); await assert.rejects(restored.resume(record.id, "missing"), /original child session file/);
  assert.equal(fx.state.calls, 2);
}));

test("stable queued completion and cancellable Fleet waiters launch no cancelled child", async () => fixture(async (fx) => {
  const limiter = new FleetLimiter(1); const release = await limiter.acquire(); const m = fx.manager("fleet", limiter);
  const one = m.spawn(fx.agent, "one", "one", fx.root, {}); const two = m.spawn(fx.agent, "two", "two", fx.root, {});
  const stable = one.promise; let settled = false; void stable!.then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(limiter.queued, 2);
  assert.equal(m.abort(two.id, "unknown"), true); assert.equal(limiter.queued, 1); await two.promise;
  assert.equal(two.result?.stopReason, "cancelled"); assert.equal(fx.state.calls, 0);
  release(); await stable; assert.equal(one.promise, stable); assert.equal(one.status, "completed"); assert.equal(fx.state.calls, 1);
  assert.equal(limiter.active, 0);
}));

test("cancel/resume single flight drains close, retains partial usage and fences old callbacks", async () => fixture(async (fx) => {
  const m = fx.manager(); fx.state.delay = 1000;
  const rt = (m as any).runtime; const originalStart = rt.start.bind(rt); const gate = deferred(); let closes = 0; let oldOptions: any;
  rt.start = (agent: any, options: any) => { oldOptions = options; const ex = originalStart(agent, options); const close = ex.close.bind(ex); ex.close = async () => { closes++; await gate.promise; await close(); }; return ex; };
  const record = m.spawn(fx.agent, "first", "first", fx.root, { persistent: true });
  await until(() => fx.state.calls === 1); m.abort(record.id, "user");
  await until(() => closes === 1);
  const oldStable = record.promise; assert.equal(record.autoContinueBlocked, true);
  await assert.rejects(m.resume(record.id, "model auto"), /Automatic continuation blocked/);
  const resumed = m.resume(record.id, "authorized", { userAuthorized: true });
  await assert.rejects(m.resume(record.id, "parallel", { userAuthorized: true }), /not resumable/);
  assert.equal(record.promise, oldStable); assert.equal(record.generation, 1);
  fx.state.delay = 0; gate.resolve(); await resumed;
  assert.equal(closes, 1); assert.equal(record.generation, 2); assert.equal(record.cumulativeUsage?.input, 6);
  oldOptions.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 999 } } });
  oldOptions.onReady({ sessionFile: "/not-the-current-file.jsonl" });
  assert.equal(record.activity?.usage.input, 3); assert.notEqual(record.launch?.sessionFile, "/not-the-current-file.jsonl");
  const claim = m.claimUsage(record.id, 2); assert.equal(claim?.input, 3);
  assert.equal(m.claimUsage(record.id, 2), undefined); assert.equal(m.claimUsage(record.id)?.input, 3); assert.equal(m.claimUsage(record.id), undefined);
  const restored = fx.manager(); assert.equal(restored.claimUsage(record.id), undefined); assert.equal(restored.get(record.id)?.cumulativeUsage?.input, 6);
}));

test("nonpersistent execution closes once before Fleet release; shutdown awaits stable close", async () => fixture(async (fx) => {
  const limiter = new FleetLimiter(1); const m = fx.manager("dispose", limiter); const rt = (m as any).runtime;
  const start = rt.start.bind(rt); const gate = deferred(); let closes = 0;
  rt.start = (agent: any, options: any) => { const ex = start(agent, options); const close = ex.close.bind(ex); ex.close = async () => { closes++; await gate.promise; await close(); }; return ex; };
  const record = m.spawn({ ...fx.agent, persistSession: false }, "ephemeral", "ephemeral", fx.root, { persistent: false });
  await until(() => closes === 1); assert.equal(limiter.active, 1);
  let stopped = false; const shutdown = m.shutdown(); void shutdown.then(() => { stopped = true; }); await tick(); assert.equal(stopped, false);
  assert.throws(() => m.spawn(fx.agent, "x", "x", fx.root, {}), /shut down/); await assert.rejects(m.resume(record.id, "x"), /shut down/);
  gate.resolve(); await shutdown; assert.equal(closes, 1); assert.equal(limiter.active, 0); assert.equal(record.execution, undefined);
}));

test("soft maxTurns is explicitly partial and runtime full artifact is never overwritten", async () => fixture(async (fx) => {
  const m = fx.manager(); fx.state.text = "界".repeat(40000);
  const record = m.spawn(fx.agent, "large", "large", fx.root, { maxTurns: 1 }); await record.promise;
  assert.equal(record.status, "stopped"); assert.equal(record.result?.stopReason, "maxTurns"); assert.equal(record.result?.partial, true);
  assert.equal(record.outputTruncated, true); assert.ok(record.outputPath); assert.equal(fs.readFileSync(record.outputPath!, "utf8"), fx.state.text);
  assert.ok(Buffer.byteLength(record.result!.output) <= 50 * 1024); assert.ok(record.result!.output.split("\n").length <= 2000);
}));

test("restoration quarantines legacy external references without reading or losing valid records; trust is current", async () => fixture(async (fx) => {
  const m = fx.manager(); const record = m.spawn(fx.agent, "legal", "legal", fx.root, {}); await record.promise;
  const registry = (m as any).registryFile; const stored = JSON.parse(fs.readFileSync(registry, "utf8"));
  const legacy = { ...stored[0], id: "legacy", launch: { ...stored[0].launch, sessionDir: "/host-private-sessions", sessionFile: "/host-private-sessions/user.jsonl" } };
  fs.writeFileSync(registry, JSON.stringify([...stored, legacy]));
  const restored = fx.manager(); assert.equal(restored.list().length, 2); assert.equal(restored.diagnostics.length, 1);
  await assert.rejects(restored.resume("legacy", "no"), /legacy child session/);
  await restored.resume(record.id, "yes"); assert.equal(restored.get("legacy")?.launch?.sessionFile, "/host-private-sessions/user.jsonl");
  restored.updateAuthorization(defaultMeshSettings, false); await assert.rejects(restored.resume(record.id, "untrusted"), /no longer trusted/);
  assert.equal(fx.state.calls, 2);
}));

test("send_subagent disabled, queued/early-ready delivery, replay, stale generation, terminal continuation and cancel lock", async () => fixture(async (fx) => {
  const disabled = fx.manager("disabled", undefined, false); await assert.rejects(disabled.send("x", "hello"), /disabled/);
  const limiter = new FleetLimiter(1); const release = await limiter.acquire(); const m = fx.manager("send", limiter);
  const record = m.spawn(fx.agent, "initial", "initial", fx.root, {});
  assert.equal((await m.send(record.id, "direction", 1, "message-1")).disposition, "queued");
  assert.equal((await m.send(record.id, "direction", 1, "message-1")).duplicate, true);
  await assert.rejects(m.send(record.id, "stale", 0), /Stale generation/);
  release(); await record.promise;
  assert.ok(fx.state.contexts.some((ctx) => ctx.messages.some((message) => JSON.stringify(message.content).includes("direction"))), "pre-ready direction reaches the real SDK");
  const first = m.send(record.id, "continue", 1, "continue-1"); const duplicate = m.send(record.id, "continue", 1, "continue-1");
  assert.equal((await duplicate).duplicate, true); assert.equal((await first).disposition, "continuation_requested");
  assert.equal(record.generation, 2); await record.promise;
  fx.state.delay = 1000; const continuation = m.resume(record.id, "slow"); await until(() => record.status === "running");
  assert.equal((await m.send(record.id, "focus", 3)).disposition === "steered" || !record.ready, true);
  m.abort(record.id, "unknown"); await continuation;
  await assert.rejects(m.send(record.id, "I am user authorized"), /Automatic continuation blocked/);
  const restored = fx.manager("send"); assert.equal(restored.get(record.id)?.autoContinueBlocked, true);
}));

test("send waits for settling close, caps pending directions, then rechecks cancellation without launching", async () => fixture(async (fx) => {
  const m = fx.manager(); const rt = (m as any).runtime; const start = rt.start.bind(rt); const gate = deferred(); let closing = false;
  rt.start = (agent: any, options: any) => { const ex = start(agent, options); const close = ex.close.bind(ex); ex.close = async () => { closing = true; await gate.promise; await close(); }; return ex; };
  const record = m.spawn(fx.agent, "first", "first", fx.root, {}); await until(() => closing);
  const pending = Array.from({ length: 16 }, (_, i) => m.send(record.id, `direction ${i}`, 1).then(() => "accepted", (error) => String(error)));
  await assert.rejects(m.send(record.id, "overflow", 1), /Direction queue full/);
  m.abort(record.id, "user"); gate.resolve(); const receipts = await Promise.all(pending);
  assert.ok(receipts.every((value) => /Automatic continuation blocked/.test(value))); assert.equal(fx.state.calls, 1);
  await record.promise;
}));

test("failed continuation clears prior successful body; nonpersistent/worktree contact has actionable refusal", async () => fixture(async (fx) => {
  const m = fx.manager(); const record = m.spawn(fx.agent, "first", "first", fx.root, {}); await record.promise;
  (m as any).runtime.connect = () => { throw new Error("injected connect failure"); };
  await m.resume(record.id, "again"); assert.equal(record.status, "failed"); assert.equal(record.result?.output, ""); assert.equal(record.previous?.generation, 1); assert.equal(record.cumulativeUsage?.input, 3);
  const ephemeral = m.spawn({ ...fx.agent, persistSession: false }, "ephemeral", "ephemeral", fx.root, { persistent: false }); await ephemeral.promise;
  await assert.rejects(m.send(ephemeral.id, "again"), /nonpersistent/);
  (ephemeral as any).worktree = { finalCommit: "evidence" };
  await assert.rejects(m.send(ephemeral.id, "again"), /Manually review/);
}));

test("record cap rejects new spawn without silently deleting recovery evidence", async () => fixture(async (fx) => {
  const m = fx.manager(); const records = (m as any).records as Map<string, any>;
  for (let i = 0; i < 1024; i++) records.set(`evidence-${i}`, { id: `evidence-${i}`, createdAt: i, status: "completed" });
  assert.throws(() => m.spawn(fx.agent, "overflow", "overflow", fx.root, {}), /record limit reached \(1024\).*Preserve recovery files/);
  assert.equal(records.size, 1024); assert.equal(fx.state.calls, 0);
  records.clear();
}));

test("Direct admission storage failure cannot start an unacknowledged child", async () => fixture(async (fx) => {
  const m = fx.manager(); const internal = m as any;
  const persist = internal.persist; const start = internal.runtime.start; let starts = 0;
  internal.persist = () => { throw new Error("injected checkpoint failure"); };
  internal.runtime.start = () => { starts++; throw new Error("must not start"); };
  try {
    assert.throws(() => m.spawn(fx.agent, "unacknowledged", "unacknowledged", fx.root, {}), /Cannot persist Agent.*no child was started/);
    await Promise.all(m.list().map((record) => record.promise)); await tick();
    assert.equal(starts, 0); assert.equal(fx.state.calls, 0); assert.equal(m.list()[0]?.status, "failed");
  } finally { internal.persist = persist; internal.runtime.start = start; }
}));

test("final checkpoint/callback failures settle and failed usage claims remain reclaimable", async () => fixture(async (fx) => {
  const limiter = new FleetLimiter(1); const m = fx.manager("durability", limiter); const internal = m as any; const persist = internal.persist;
  internal.persist = function () { if (m.list().some((record) => record.status === "completed")) throw new Error("final checkpoint failure"); return persist.call(m); };
  m.setOnComplete(() => { throw new Error("completion callback failure"); });
  const record = m.spawn(fx.agent, "result", "result", fx.root, {});
  await record.promise;
  assert.equal(record.status, "failed"); assert.equal(record.result?.output, "LOCAL_OK");
  assert.match(record.error ?? "", /Cannot persist final Agent state/); assert.equal(limiter.active, 0);
  assert.ok(m.diagnostics.some((item) => /Completion callback failed/.test(item.message)));
  internal.persist = () => { throw new Error("claim checkpoint failure"); };
  assert.throws(() => m.claimUsage(record.id), /claim checkpoint failure/);
  assert.equal(record.unclaimedUsage?.input, 3); assert.equal(record.claimedGeneration, undefined);
  internal.persist = persist;
  assert.equal(m.claimUsage(record.id)?.input, 3); assert.equal(m.claimUsage(record.id), undefined);
}));

test("32KiB contact payload works while running and continuation receipts stay within 128", async () => fixture(async (fx) => {
  const m = fx.manager(); fx.state.delay = 100;
  const record = m.spawn(fx.agent, "running", "running", fx.root, {});
  await until(() => Boolean(record.ready) && fx.state.calls > 0);
  const payload = "x".repeat(32768);
  assert.equal((await m.send(record.id, payload, 1, "boundary")).disposition, "steered");
  await record.promise;
  assert.ok(fx.state.contexts.some((ctx) => ctx.messages.some((message) => JSON.stringify(message.content).includes(payload))));
  record.receipts = Array.from({ length: 127 }, (_, index) => ({ key: `existing-${index}`, generation: 1, disposition: "steered" }));
  const calls = fx.state.calls;
  await assert.rejects(m.send(record.id, "overflow", 1, "new-continuation"), /receipt limit/);
  assert.equal(record.receipts.length, 127); assert.equal(record.generation, 1); assert.equal(fx.state.calls, calls);
}));

test("a rejected continuation does not poison its message deduplication receipt", async () => fixture(async (fx) => {
  const m = fx.manager(); const record = m.spawn(fx.agent, "initial", "initial", fx.root, {}); await record.promise;
  const pending = m.send(record.id, "retryable direction", 1, "retryable-id");
  m.updateAuthorization({ ...defaultMeshSettings, directCommunication: true }, false);
  await assert.rejects(pending, /no longer trusted/);
  assert.equal(record.receipts?.some((receipt) => receipt.key === "retryable-id"), false);
  m.updateAuthorization({ ...defaultMeshSettings, directCommunication: true }, true);
  assert.equal((await m.send(record.id, "retryable direction", 1, "retryable-id")).disposition, "continuation_requested");
  await record.promise; assert.equal(fx.state.calls, 2);
}));

test("a new cancellation while user-authorized resume is draining requires fresh authorization", async () => fixture(async (fx) => {
  const m = fx.manager(); fx.state.delay = 1000;
  const rt = (m as any).runtime; const start = rt.start.bind(rt); const gate = deferred(); let closing = false;
  rt.start = (agent: any, options: any) => { const ex = start(agent, options); const close = ex.close.bind(ex); ex.close = async () => { closing = true; await gate.promise; await close(); }; return ex; };
  const record = m.spawn(fx.agent, "first", "first", fx.root, {}); await until(() => fx.state.calls === 1); m.abort(record.id, "user"); await until(() => closing);
  const authorized = m.resume(record.id, "authorized", { userAuthorized: true });
  m.abort(record.id, "unknown"); gate.resolve(); await assert.rejects(authorized, /new cancellation while draining/);
  assert.equal(fx.state.calls, 1); assert.equal(record.autoContinueBlocked, true);
}));

for (const stage of ["admission", "final", "claim"] as const) test(`review Direct real SDK ${stage} post-rename failure is compensated on disk`, async () => fixture(async (fx) => {
  const m = fx.manager(), file = (m as any).registryFile;
  const fault = failDirectorySync((candidate) => candidate === file && (stage === "admission" || stage === "final" && JSON.parse(fs.readFileSync(file, "utf8"))[0]?.status === "completed"));
  if (stage === "claim") fault.restore();
  let record: ReturnType<typeof m.spawn> | undefined;
  try {
    if (stage === "admission") {
      assert.throws(() => m.spawn(fx.agent, "must not execute", "no", fx.root, {}), /no child was started/); assert.equal(fx.state.calls, 0);
      assert.equal(fx.manager().list()[0]?.status, "failed");
    } else {
      record = m.spawn(fx.agent, "usage", "usage", fx.root, {}); await record.promise;
      if (stage === "final") { assert.equal(record.status, "failed"); assert.equal(fx.manager().get(record.id)?.status, "failed"); }
    }
    if (stage !== "claim") assert.equal(fault.hits, 1);
  } finally { fault.restore(); }
  if (stage === "claim") {
    const claim = failDirectorySync((candidate) => candidate === file);
    try { assert.throws(() => m.claimUsage(record!.id, 1), /fsync/); assert.equal(claim.hits, 1); } finally { claim.restore(); }
    const restored = fx.manager(); assert.equal(restored.claimUsage(record!.id, 1)?.input, 3); assert.equal(restored.claimUsage(record!.id), undefined);
    assert.equal(fx.manager().claimUsage(record!.id), undefined); assert.equal(fx.state.calls, 1);
  }
}));
