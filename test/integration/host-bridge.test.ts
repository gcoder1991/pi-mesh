import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { MeshManager } from "../../src/manager.ts";
import { SessionAgentManager } from "../../src/session-agents.ts";
import { defaultMeshSettings, loadMeshSettings, type BridgeRoute, type BridgeTarget } from "../../src/settings.ts";
import { BRIDGE_INBOX, bridgeMessages, bridgeSpoolRoot, bridgeLocal, incomingBridgeId, registerHostBridge } from "../../src/host-bridge.ts";
import { BRIDGE_PREFIX, RECEIVED, RPC_INFO, RPC_SEND, requestRpc, type EventBus } from "../../src/bridge-wire.ts";
import { messages, ackMessage, putMessage } from "../../src/store.ts";
import registerPiMesh from "../../src/extension.ts";
import { failDirectorySync } from "../support/atomic-fault.ts";

class Bus implements EventBus {
  listeners = new Map<string, Set<(data: any) => void>>();
  on(topic: string, handler: (data: any) => void) { const set = this.listeners.get(topic) ?? new Set(); set.add(handler); this.listeners.set(topic, set); return () => { set.delete(handler); if (!set.size) this.listeners.delete(topic); }; }
  emit(topic: string, data: unknown) { for (const handler of [...this.listeners.get(topic) ?? []]) handler(data); }
  get count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
const local = { sessionId: "host-session", instanceId: "a".repeat(32) }, peer = "b".repeat(32);
async function fixture(fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<void> | void, long = false) {
  const f = await setup(long); try { await fn(f); } finally { await f.close(); }
}
async function setup(long = false) {
  const baseRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-component-")));
  const root = long ? path.join(baseRoot, ...Array(3).fill("long-" + "x".repeat(170))) : baseRoot; fs.mkdirSync(root, { recursive: true });
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const settingsFile = path.join(process.env.PI_CODING_AGENT_DIR, "mesh", "settings.yaml"); fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const bus = new Bus(), hooks = new Map<string, Array<(e: any, c: any) => any>>();
  let trusted = true, sessionId = local.sessionId, infoLocal = { ...local }, claimCount = 0, hintCount = 0, coreRpc = true, coreStopped = false;
  const tools = new Map<string, any>(); let registered = false;
  const pi: any = { registerTool(t: any) { tools.set(t.name, t); }, registerCommand() {}, registerShortcut() {}, events: bus, on: (name: string, cb: any) => { const list = hooks.get(name) ?? []; list.push(cb); hooks.set(name, list); }, sendMessage() { throw new Error("Host SDK injection forbidden"); } };
  const ctx: any = { mode: "print", modelRegistry: { getAvailable: () => [] }, ui: { notify() {} }, cwd: root, sessionManager: { getSessionId: () => sessionId }, isProjectTrusted: () => trusted };
  const settings = { ...defaultMeshSettings, mailboxNotifications: true };
  const manager = new MeshManager(() => ({ name: "test", description: "test", systemPrompt: "test", source: "bundled", filePath: "synthetic-definition" }), settings, undefined, undefined, local.sessionId, true);
  const direct = new SessionAgentManager(settings, root, undefined, local.sessionId, undefined, undefined, true);
  const run = manager.create({ cwd: root, tasks: [{ id: "a", agent: "test", task: "not started" }, { id: "b", agent: "test", task: "not started" }] });
  const target: BridgeTarget = { root, sessionId, kind: "mesh", runId: run.id, nodeId: "a", attempt: 0 };
  let routes: BridgeRoute[] = [{ routeId: "route", peerInstanceId: peer, remoteRoute: "remote", localTarget: target, remoteTarget: { ...target, sessionId: "peer-session" }, mode: "store" }];
  function write(enabled = true) { fs.writeFileSync(settingsFile, JSON.stringify({ bridge: { enabled, routes }, mailboxNotifications: true })); }
  write();
  const offInfo = bus.on(RPC_INFO, q => { if (coreRpc) bus.emit(`${RPC_INFO}:reply:${q.requestId}`, { version: 1, requestId: q.requestId, ok: true, local: infoLocal, stopped: coreStopped, capability: "cancel-safe-queue-v1" }); });
  let adapter = registerHostBridge(pi, () => manager, () => direct);
  const fire = async (name: string) => { for (const cb of hooks.get(name) ?? []) await cb({}, ctx); };
  await fire("session_start");
  function event(id = "message", patch: Record<string, any> = {}, onClaim?: () => boolean) {
    const envelope = { version: 1, origin: peer, correlationId: "correlation", expiresAt: Date.now() + 30_000, hops: 0, budget: 4, payload: { version: 1, route: "route", target: routes[0]!.localTarget, content: `body-${id}`, claim: "host-transcribed-not-user" } };
    let claimed = false, open = true;
    const e = Object.freeze({ version: 1, local: { ...local }, source: Object.freeze({ id: "peer-session", instanceId: peer, name: "same-name", ref: "bbbb", cwd: root, pid: process.pid }), messageId: id, sentAt: Date.now(), text: BRIDGE_PREFIX + JSON.stringify(envelope), bridge: envelope, canHandle: true, reply(_result?: unknown) { if (!open || claimed) return false; if (onClaim && !onClaim()) return false; claimed = true; claimCount++; return true; }, ...patch });
    bus.emit(RECEIVED, e); open = false;
    return { e, claimed };
  }
  return { root, bus, manager, direct, run, ctx, event, target, settingsFile,
    async registered() {
      if (!registered) { await fire('session_shutdown'); hooks.clear(); registerPiMesh(pi); await fire('session_start'); registered = true; }
      return tools.get('mesh');
    },
    get adapter() { return adapter; }, get routes() { return routes; }, set routes(value: BridgeRoute[]) { routes = value; }, write, fire,
    get claims() { return claimCount; }, get hints() { return hintCount; },
    trusted(value: boolean) { trusted = value; }, session(value: string) { sessionId = value; }, info(value: typeof local) { infoLocal = value; }, rpc(value: boolean) { coreRpc = value; }, stopped(value: boolean) { coreStopped = value; },
    // Component-only controllable execution; real SDK/live-target test is separate.
    activate() { const node = run.nodes[0]!; node.status = "running"; const ex = { steerActive: () => { hintCount++; return true; } }; (manager as any).subagents.set(run.id, new Map([[node.id, ex]])); (manager as any).executionAttempts.set(ex, node.attempt); (manager as any).nodeControllers.set(run.id, new Map([[node.id, new AbortController()]])); },
    async restart() { registered = false; await fire("session_shutdown"); hooks.clear(); adapter = registerHostBridge(pi, () => manager, () => direct); await fire("session_start"); },
    async close() { await fire("session_shutdown"); offInfo(); assert.equal(bus.count, 0); await manager.shutdown(); await direct.shutdown(); if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; fs.rmSync(baseRoot, { recursive: true, force: true }); },
  };
}

test("bridge user-only configuration defaults off; trusted/untrusted project cannot enable or remap", async () => fixture(f => {
  fs.writeFileSync(f.settingsFile, "{}");
  const project = path.join(f.root, ".pi", "mesh", "settings.yaml"); fs.writeFileSync(project, JSON.stringify({ bridge: { enabled: true, routes: f.routes } }));
  assert.equal(loadMeshSettings(f.root).bridge.enabled, false); assert.equal(loadMeshSettings(f.root, process.env, false).bridge.enabled, false);
  assert.equal(f.event().claimed, false);
  f.write(); fs.writeFileSync(project, JSON.stringify({ bridge: { enabled: false, routes: [{ malicious: true }] } }));
  assert.deepEqual(loadMeshSettings(f.root).bridge.routes, f.routes);
  f.trusted(false); assert.equal(f.event().claimed, false); f.trusted(true); assert.equal(f.event().claimed, true);
  assert.throws(() => { fs.writeFileSync(f.settingsFile, JSON.stringify({ bridge: { enabled: "true" } })); loadMeshSettings(f.root); }, /bridge/);
}));

test("bridge sync claim, missing Core RPC, wrong local, late/duplicate reply have no unauthorized side effects", async () => fixture(f => {
  f.rpc(false); assert.equal(f.event().claimed, false); assert.throws(() => bridgeLocal(f.bus, local.sessionId), /RPC/);
  f.rpc(true); f.info({ ...local, instanceId: "c".repeat(32) }); assert.equal(f.event().claimed, false); f.info(local);
  assert.equal(f.event("legacy", { canHandle: false }).claimed, false);
  assert.equal(f.event("other-claimed", {}, () => false).claimed, false);
  const accepted = f.event(); assert.equal(accepted.claimed, true); assert.equal(accepted.e.reply({ handled: true }), false);
  assert.equal(messages(f.root, f.run.id).length, 1);
  const retained = bridgeMessages();
  f.event("reentrant", {}, () => { f.trusted(false); return true; }); assert.equal(messages(f.root, f.run.id).length, 1); assert.deepEqual(bridgeMessages(), retained);
  f.trusted(true); const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.event("abort-in-claim", {}, () => { controller.abort(); return true; }); assert.equal(messages(f.root, f.run.id).length, 1); assert.deepEqual(bridgeMessages(), retained);
  f.ctx.signal = new AbortController().signal; // backoff/cleanup may leave an old non-aborted SDK signal
  f.event("core-stop-in-claim", {}, () => { f.stopped(true); return true; }); assert.equal(messages(f.root, f.run.id).length, 1); assert.deepEqual(bridgeMessages(), retained);
  assert.equal(f.event("stopped-core").claimed, false);
  assert.deepEqual(bridgeLocal(f.bus, local.sessionId), local, "read-only bootstrap and fresh user outbound are not blanket-blocked by inbound latch");
}));

test("bridge exact authenticated peer and target generation; no names, short refs, origin or fields grant authority", async () => fixture(f => {
  for (const source of [Object.freeze({ id: "other", instanceId: "c".repeat(32), name: "same-name" }), Object.freeze({ id: "peer-session", instanceId: "bbbb" })]) assert.equal(f.event("wrong", { source }).claimed, false);
  for (const change of [{ attempt: 1 }, { sessionId: "another" }, { root: path.dirname(f.root) }]) {
    const target = { ...f.target, ...change };
    const base: any = f.event("seed", { canHandle: false }).e.bridge;
    const bridge = { ...base, payload: { ...base.payload, target } };
    assert.equal(f.event("wrong", { bridge, text: BRIDGE_PREFIX + JSON.stringify(bridge) }).claimed, false);
  }
  const base: any = f.event("seed", { canHandle: false }).e.bridge;
  for (const change of [{ claim: "user" }, { userAuthorized: true }, { content: "x".repeat(32769) }]) {
    const bridge = { ...base, payload: { ...base.payload, ...change } };
    assert.equal(f.event("spoof", { bridge, text: BRIDGE_PREFIX + JSON.stringify(bridge) }).claimed, false);
  }
  assert.equal(f.claims, 0); assert.equal(messages(f.root, f.run.id).length, 0);
}));

test("bridge passive mode with general notifications true gives zero hints; active hints cap at eight and cancellation fences", async () => fixture(f => {
  f.activate(); f.event("passive"); assert.equal(f.hints, 0);
  f.routes[0]!.mode = "active"; f.write();
  for (let n = 0; n < 10; n++) f.event(`active-${n}`);
  assert.equal(f.hints, 8); assert.equal(messages(f.root, f.run.id).length, 11);
  assert.equal(f.manager.cancel(f.run.id, "a", "user"), true);
  f.event("after-cancel"); assert.equal(f.hints, 8); assert.equal(f.run.nodes[0]!.status, "cancelled");
  assert.equal(f.run.nodes[0]!.attempt, 0);
}));

test("bridge active queued/paused/terminal/cancelled targets stay data-only, never create a topology", async () => fixture(f => {
  f.routes[0]!.mode = "active"; f.write();
  for (const status of ["queued", "paused", "succeeded", "failed", "cancelled"] as const) { f.run.nodes[0]!.status = status; f.event(status); assert.equal(f.run.nodes[0]!.status, status); }
  assert.equal(f.hints, 0); assert.equal(f.manager.list().length, 1); assert.equal(f.run.nodes.length, 2); assert.equal(f.run.nodes[0]!.attempt, 0);
}));

test("bridge qualified dedup survives ack, adapter restart and changed target; authenticated source qualifies IDs", async () => fixture(async f => {
  f.event(); const id = incomingBridgeId(peer, "message"); assert.equal(ackMessage(bridgeSpoolRoot(), BRIDGE_INBOX, id, "host"), true);
  await f.restart(); f.routes[0]!.localTarget = { ...f.target, kind: "mesh", runId: f.run.id, nodeId: "b", attempt: 0 }; f.write();
  f.event(); assert.equal(messages(f.root, f.run.id).length, 1); assert.equal(messages(f.root, f.run.id)[0]!.to, "a");
  assert.notEqual(incomingBridgeId("c".repeat(32), "message"), id);
  const existing = bridgeMessages().find(m => m.id === id)!;
  const receipt = putMessage(bridgeSpoolRoot(), { ...existing, content: "replacement forbidden" }, { payloadMaxBytes: 65536, recipientUnreadMaxBytes: 1, ifAbsent: true });
  assert.equal(receipt.duplicate, true); assert.equal(bridgeMessages().find(m => m.id === id)!.content, existing.content);
}));

test("bridge real directory fsync warning preserves incoming ID, honest outcome and no live submission", async () => fixture(f => {
  f.activate(); f.routes[0]!.mode = "active"; f.write();
  const id = incomingBridgeId(peer, "fsync"), fault = failDirectorySync(file => file.endsWith(`/host-bridge/${id}.json`));
  try { assert.equal(f.event("fsync").claimed, true); assert.equal(fault.hits, 1); } finally { fault.restore(); }
  const result = JSON.parse(bridgeMessages().find(m => m.id === `${id}-outcome`)!.content);
  assert.equal(result.admission.outcome, "stored-visible"); assert.equal(result.notification, "not-requested"); assert.equal(f.hints, 0); assert.equal(messages(f.root, f.run.id).length, 0);
  f.event("fsync"); assert.equal(messages(f.root, f.run.id).length, 0);
}));

test("bridge actual unknown storage retains ID/outcome and never suggests safe retry or executes", async () => fixture(f => {
  const read = fs.readFileSync, id = incomingBridgeId(peer, "unknown"); let unreadable = 0;
  const fault = failDirectorySync(file => { if (file.endsWith(`/host-bridge/${id}.json`)) { unreadable = 2; return true; } return false; });
  fs.readFileSync = ((file: any, ...args: any[]) => { if (String(file).endsWith(`/host-bridge/${id}.json`) && unreadable > 0) { unreadable--; throw new Error("actual visibility fault"); } return (read as any)(file, ...args); }) as any; syncBuiltinESMExports();
  try { f.event("unknown"); assert.equal(fault.hits, 1); assert.equal(unreadable, 0); } finally { fs.readFileSync = read; fault.restore(); syncBuiltinESMExports(); }
  const result = JSON.parse(bridgeMessages().find(m => m.id.startsWith("failure-") && JSON.parse(m.content).inboxId === id)!.content);
  assert.equal(bridgeMessages().some(m => m.id === `${id}-outcome`), false, "unknown reservation ownership cannot occupy canonical outcome");
  assert.equal(result.local.sessionId, local.sessionId);
  assert.equal(result.admission.id, id); assert.equal(result.admission.outcome, "unknown"); assert.equal(messages(f.root, f.run.id).length, 0);
  f.event("unknown"); assert.equal(messages(f.root, f.run.id).length, 0);
}));

test("bridge TTL/hops/budget reject before claim and per-target budget survives enable toggles and restart", async () => fixture(async f => {
  const base: any = f.event("seed", { canHandle: false }).e.bridge;
  for (const change of [{ expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 31000 }, { hops: 5 }, { budget: 0 }]) {
    const bridge = { ...base, ...change }; assert.equal(f.event("expired", { bridge, text: BRIDGE_PREFIX + JSON.stringify(bridge) }).claimed, false);
  }
  for (let n = 0; n < 64; n++) assert.equal(f.event(`limit-${n}`).claimed, true);
  f.write(false); assert.equal(f.event("off").claimed, false); f.write(); await f.restart();
  assert.equal(f.event("limit-65").claimed, false); assert.equal(messages(f.root, f.run.id).length, 64);
}));

test("bridge forward derives immutable origin/correlation/TTL/body and decrements hops/budget from existing inbox", async () => fixture(async f => {
  f.event("forward"); const original = JSON.parse(bridgeMessages()[0]!.content), inboxId = incomingBridgeId(peer, "forward");
  let request: any;
  const off = f.bus.on(RPC_SEND, q => { request = q; const reply = { version: 1, requestId: q.requestId, local: q.local, ok: true, messageId: q.messageId, target: { instanceId: q.remoteInstanceId }, receipt: { status: "accepted" } }; f.bus.emit(`${RPC_SEND}:reply:${q.requestId}`, reply); f.bus.emit(`${RPC_SEND}:reply:${q.requestId}`, { ...reply, ok: false }); });
  try {
    const receipt: any = await f.adapter.execute("bridge_send", { routeId: "route", forwardInboxId: inboxId }, undefined, f.ctx);
    await assert.rejects(() => f.adapter.execute("bridge_send", { routeId: "route", messageId: "replace-old", content: "retry" }, undefined, f.ctx), /replacement message IDs/);
    assert.equal(receipt.completed, false); assert.equal(receipt.receipt.receipt.status, "accepted");
    const forwarded = JSON.parse(request.text.slice(BRIDGE_PREFIX.length));
    for (const key of ["origin", "correlationId", "expiresAt"]) assert.equal(forwarded[key], original.envelope[key]);
    assert.equal(forwarded.hops, 1); assert.equal(forwarded.budget, 3); assert.equal(forwarded.payload.content, "body-forward"); assert.equal(forwarded.payload.route, "remote");
    await assert.rejects(() => f.adapter.execute("bridge_send", { routeId: "route", forwardInboxId: inboxId, content: "forged" }, undefined, f.ctx), /only from/);
    await assert.rejects(() => f.adapter.execute("bridge_send", { routeId: "route", forwardInboxId: "unknown" }, undefined, f.ctx), /existing/);
  } finally { off(); }
}));

test("bridge RPC bounded missing listener, shutdown abort, unsubscribe and session replacement fence", async () => fixture(async f => {
  const count = f.bus.count;
  await assert.rejects(requestRpc(f.bus, RPC_SEND, { version: 1, requestId: "no-listener" }, 10), (error: any) => error.code === "receipt_unknown" && error.retryable === false);
  assert.equal(f.bus.count, count);
  const pending = f.adapter.execute("bridge_send", { routeId: "route", content: "no peer" }, undefined, f.ctx);
  await f.fire("session_shutdown"); const result: any = await pending;
  assert.equal(result.receipt.state, "receipt_unknown"); assert.equal(f.bus.count, 1);
  await f.fire("session_start"); f.session("new-session"); assert.equal(f.event("old-session").claimed, false);
}));

test("bridge managed frozen identity is child-local; same-PID independent Host is not suppressed", async () => fixture(async f => {
  const off = f.bus.on("pi-mesh:runtime:identity:query", q => q.reply(Object.freeze({ version: 1, managed: true })));
  await f.fire("session_start"); assert.equal(f.event("child").claimed, false); assert.equal(f.bus.listeners.has(RECEIVED), false);
  off(); await f.fire("session_start"); assert.equal(f.event("host").claimed, true);
}));

test("bridge Direct exact live generation fences readiness, settling, stop and stale generation without send/resume", async () => fixture(f => {
  let submitted = 0;
  const record: any = { id: "direct-exact", generation: 3, cwd: f.root, status: "running", ready: true, settling: false, execution: { steerActive: () => { submitted++; return true; }, abort() {} }, agent: {}, createdAt: Date.now() };
  (f.direct as any).records.set(record.id, record);
  (f.direct as any).send = () => { throw new Error("Forbidden terminal send path"); };
  (f.direct as any).resume = () => { throw new Error("Forbidden resume path"); };
  f.routes[0]!.localTarget = { root: f.root, sessionId: local.sessionId, kind: "direct", id: record.id, generation: 3 }; f.routes[0]!.mode = "active"; f.write();
  f.event("direct-live"); assert.equal(submitted, 1);
  for (const patch of [{ ready: false }, { settling: true }, { autoContinueBlocked: true }, { status: "queued" }, { status: "completed" }, { status: "stopped" }]) {
    Object.assign(record, { status: "running", ready: true, settling: false, autoContinueBlocked: false }, patch);
    f.event(`direct-${JSON.stringify(patch).replace(/[^A-Za-z]/g, "")}`); assert.equal(submitted, 1);
  }
  record.generation = 4; assert.equal(f.event("stale-generation").claimed, false); assert.equal(record.generation, 4); record.status = "stopped"; record.settling = false;
}));

test("bridge real mailbox quota failure is separate from canonical stored evidence; no notify and disabled inbox remains inspectable", async () => fixture(async f => {
  f.activate(); f.routes[0]!.mode = "active";
  fs.writeFileSync(f.settingsFile, JSON.stringify({ bridge: { enabled: true, routes: f.routes }, recipientUnreadMaxBytes: 1, mailboxNotifications: true }));
  f.event("quota"); const id = incomingBridgeId(peer, "quota");
  const outcome = JSON.parse(bridgeMessages().find(m => m.id === `${id}-outcome`)!.content);
  assert.equal(outcome.admission.outcome, "stored"); assert.equal(outcome.mailbox.outcome, "not-stored"); assert.equal(outcome.mailbox.id, id); assert.equal(f.hints, 0);
  f.write(false); f.rpc(false);
  const inbox: any = await f.adapter.execute("bridge_inbox", { messageId: id }, undefined, f.ctx); assert.equal(inbox.entries.length, 2);
  const status: any = await f.adapter.execute("bridge_status", {}, undefined, f.ctx); assert.equal(status.enabled, false); assert.equal(status.local, null);
}));

test("bridge stale attempts and actual Mesh ownership loss cannot hint a new or foreign execution", async () => fixture(f => {
  f.activate(); f.routes[0]!.mode = "active"; f.write();
  f.run.nodes[0]!.attempt = 1; assert.equal(f.event("old-attempt").claimed, false); f.run.nodes[0]!.attempt = 0;
  const file = path.join(f.root, ".pi", "mesh", "runs", `${f.run.id}.json`), disk = JSON.parse(fs.readFileSync(file, "utf8")); disk.revision++; fs.writeFileSync(file, JSON.stringify(disk));
  f.event("lost-owner"); assert.equal(f.hints, 0); assert.ok(f.manager.diagnostics.length === 0, "adapter catches active ownership failure without another execution");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).revision, disk.revision);
}));

test("bridge forwarding truly terminates at hop/remaining-budget limits without emitting RPC", async () => fixture(async f => {
  let sent = 0; const off = f.bus.on(RPC_SEND, () => sent++);
  try {
    for (const [id, change] of [["hop-end", { hops: 4 }], ["budget-end", { budget: 1 }]] as const) {
      const base: any = f.event("seed", { canHandle: false }).e.bridge, bridge = { ...base, ...change };
      assert.equal(f.event(id, { bridge, text: BRIDGE_PREFIX + JSON.stringify(bridge) }).claimed, true);
      await assert.rejects(() => f.adapter.execute("bridge_send", { routeId: "route", forwardInboxId: incomingBridgeId(peer, id) }, undefined, f.ctx), /Invalid\/expired bridge/);
    }
    assert.equal(sent, 0);
  } finally { off(); }
}));

test("bridge total 256 admissions really terminates across distinct targets and ack/restart", async () => fixture(async f => {
  const run = f.manager.create({ cwd: f.root, tasks: ["a", "b", "c", "d", "e"].map(id => ({ id, agent: "test", task: "unstarted bounded topology" })) });
  for (let target = 0; target < 4; target++) {
    f.routes[0]!.localTarget = { root: f.root, sessionId: local.sessionId, kind: "mesh", runId: run.id, nodeId: run.nodes[target]!.id, attempt: 0 }; f.write();
    for (let n = 0; n < 64; n++) assert.equal(f.event(`total-${target}-${n}`).claimed, true);
  }
  f.routes[0]!.localTarget = { root: f.root, sessionId: local.sessionId, kind: "mesh", runId: run.id, nodeId: "e", attempt: 0 }; f.write();
  assert.equal(f.event("total-257").claimed, false); assert.equal(messages(f.root, run.id).length, 256);
  ackMessage(bridgeSpoolRoot(), BRIDGE_INBOX, incomingBridgeId(peer, "total-0-0"), "host"); await f.restart();
  assert.equal(f.event("total-after-restart").claimed, false);
}));

test("bridge canonical dedup is independent of current project root or mapping target", async () => fixture(async f => {
  f.event("root-independent");
  const second = path.join(f.root, "second-project"); fs.mkdirSync(second);
  const run = f.manager.create({ cwd: second, tasks: [{ id: "other", agent: "test", task: "already-existing, never started" }] });
  f.ctx.cwd = second;
  f.routes[0]!.localTarget = { root: second, sessionId: local.sessionId, kind: "mesh", runId: run.id, nodeId: "other", attempt: 0 }; f.write();
  await f.fire("session_start");
  assert.equal(f.event("root-independent").claimed, true);
  assert.equal(messages(second, run.id).length, 0);
  assert.equal(messages(f.root, f.run.id).length, 1);
  assert.equal(bridgeMessages().filter(m => m.id === incomingBridgeId(peer, "root-independent")).length, 1);
}));

test('bridge review B3 full UTF-8 failed attempt retained, durable failure cap and all bounded inbox IDs remain discoverable', async () => fixture(async f => {
  const rename = fs.renameSync; let hits = 0;
  fs.renameSync = ((from: any, to: any) => { if (/\/host-bridge\/in-[a-f0-9]+\.json$/.test(String(to))) { hits++; throw new Error('native pre-rename canonical failure'); } return rename(from, to); }) as typeof fs.renameSync; syncBuiltinESMExports();
  const body = '😀'.repeat(8192);
  try {
    for (let i = 0; i < 64; i++) {
      const base: any = f.event('seed', { canHandle: false }).e.bridge;
      const bridge = { ...base, payload: { ...base.payload, content: body } };
      f.event(`failed-${i}`, { bridge, text: BRIDGE_PREFIX + JSON.stringify(bridge) });
    }
    assert.equal(hits, 64); assert.equal(bridgeMessages().length, 64);
    await f.restart(); f.event('after-restart'); assert.equal(hits, 65); assert.equal(bridgeMessages().length, 64, 'durable failure budget does not replenish');
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const first = bridgeMessages()[0]!; const evidence = JSON.parse(first.content);
  assert.equal(evidence.envelope.payload.content, body); assert.equal(evidence.local.sessionId, local.sessionId); assert.ok(evidence.inboxId.startsWith('in-'));
  f.write(false); f.rpc(false); await f.restart();
  assert.equal((await f.adapter.execute('bridge_status', {}, undefined, f.ctx) as any).failureCount, 64);
  const selected: any = await f.adapter.execute('bridge_inbox', { messageId: first.id }, undefined, f.ctx);
  assert.equal(selected.count, 1); assert.ok(selected.evidencePath || selected.entries[0].content);
  // Maximum canonical/failure listing sizes, including ACK metadata. Synthetic
  // capacity fixture uses the real spool, not 512 executions or fake receipts.
  for (let i = 0; i < 256; i++) putMessage(bridgeSpoolRoot(), { id: `in-${i.toString(16).padStart(64, '0')}`, runId: BRIDGE_INBOX, from: 'host', to: 'host', content: JSON.stringify({ local }), createdAt: Date.now(), ackedAt: Date.now() });
  for (let i = 64; i < 256; i++) putMessage(bridgeSpoolRoot(), { id: `failure-${i.toString(16).padStart(36, '0')}`, runId: BRIDGE_INBOX, from: 'host', to: 'failures', content: JSON.stringify({ local }), createdAt: Date.now(), ackedAt: Date.now() });
  const inbox: any = await f.adapter.execute('bridge_inbox', {}, undefined, f.ctx);
  assert.equal(inbox.count, 512); assert.equal(new Set(inbox.entries.map((m: any) => m.id)).size, 512); assert.ok(Buffer.byteLength(JSON.stringify(inbox)) < 48 * 1024);
}));

// Registered Mesh tool with a component ExtensionAPI/ctx, not adapter output and
// not a real SDK Host. The independent real SDK bridge suite remains separate.
async function formal(f: Awaited<ReturnType<typeof setup>>, action: string, args: any = {}) {
  const tool = await f.registered();
  return await tool.execute('query', { action, ...args }, undefined, undefined, f.ctx);
}
const diagnosticReceipt = (status: any, id: string) => {
  const row = status.diagnostics.find((v: string) => v.includes(id)); assert.ok(row, 'diagnostic includes base ID');
  const parsed = JSON.parse(row); assert.equal(parsed.id, id); assert.match(parsed.failureId, /^failure-/);
  assert.ok(parsed.admission.outcome); assert.ok(parsed.evidence.outcome); assert.ok(parsed.evidence.error || parsed.evidence.code || parsed.evidence.durabilityWarning || parsed.evidence.outcome === 'stored');
  assert.doesNotMatch(row, /\uFFFD/); return parsed;
};

for (const native of ['readdir', 'realpath', 'settings']) test(`bridge second S2 post-successful-claim native ${native} failure has owned bounded passive evidence`, async () => fixture(async f => {
  const readDir = fs.readdirSync, real = fs.realpathSync, read = fs.readFileSync; let armed = false, hits = 0;
  const fail = () => { armed = false; hits++; throw Object.assign(new Error(`post-claim ${native} EIO`), { code: 'EIO', syscall: native }); };
  fs.readdirSync = ((file: any, ...args: any[]) => { if (armed && native === 'readdir' && String(file).endsWith('/messages/host-bridge')) fail(); return (readDir as any)(file, ...args); }) as any;
  fs.realpathSync = ((file: any, ...args: any[]) => { if (armed && native === 'realpath') fail(); return (real as any)(file, ...args); }) as any;
  fs.readFileSync = ((file: any, ...args: any[]) => { if (armed && native === 'settings' && String(file) === f.settingsFile) fail(); return (read as any)(file, ...args); }) as any;
  syncBuiltinESMExports();
  try { assert.equal(f.event(`claim-${native}`, {}, () => { armed = true; return true; }).claimed, true); assert.equal(hits, 1); }
  finally { fs.readdirSync = readDir; fs.realpathSync = real; fs.readFileSync = read; syncBuiltinESMExports(); }
  const id = incomingBridgeId(peer, `claim-${native}`), all = bridgeMessages();
  assert.equal(all.length, 1); assert.match(all[0]!.id, /^failure-/); assert.equal(messages(f.root, f.run.id).length, 0);
  const evidence = JSON.parse(all[0]!.content); assert.equal(evidence.inboxId, id); assert.deepEqual(evidence.local, local); assert.equal(evidence.source.sessionId, 'peer-session'); assert.equal(evidence.admission.stage, 'claimed-before-reservation');
  assert.equal((await f.adapter.execute('bridge_status', {}, undefined, f.ctx) as any).totalUsed, 1);
  for (const restart of [false, true]) {
    f.write(false); f.rpc(false); if (restart) await f.restart();
    const list = await formal(f, 'bridge_inbox'), selected = await formal(f, 'bridge_inbox', { messageId: id }), status = await formal(f, 'bridge_status');
    assert.equal(list.details.count, 1); assert.equal(selected.details.count, 1); assert.equal(status.details.failureCount, 1); assert.equal(status.details.evidenceCount, 0); assert.equal(status.details.local, null);
    assert.equal(JSON.parse(status.content[0].text).failureCount, 1);
  }
}));

for (const revoke of ['trust', 'abort', 'session', 'stop', 'disabled']) test(`bridge second S2 post-claim native fault plus ${revoke} revocation never mutates files`, async () => fixture(async f => {
  const readDir = fs.readdirSync; let armed = false, hits = 0;
  fs.readdirSync = ((file: any, ...args: any[]) => {
    if (armed && String(file).endsWith('/messages/host-bridge')) {
      armed = false; hits++;
      if (revoke === 'trust') f.trusted(false);
      if (revoke === 'abort') { const c = new AbortController(); c.abort(); f.ctx.signal = c.signal; }
      if (revoke === 'session') f.session('replacement');
      if (revoke === 'stop') f.stopped(true);
      if (revoke === 'disabled') f.write(false);
      throw Object.assign(new Error('native EIO with concurrent authority loss'), { code: 'EIO' });
    }
    return (readDir as any)(file, ...args);
  }) as any; syncBuiltinESMExports();
  try { assert.equal(f.event(`revoked-${revoke}`, {}, () => { armed = true; return true; }).claimed, true); assert.equal(hits, 1); }
  finally { fs.readdirSync = readDir; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(path.join(bridgeSpoolRoot(), '.pi/mesh/messages')), false, 'no failure/canonical/lock directory effect');
  assert.equal(messages(f.root, f.run.id).length, 0);
}));

test('bridge second S3 real long-path double lockbusy diagnostic retains both receipts', async () => fixture(async f => {
  await f.registered();
  const dir = path.join(bridgeSpoolRoot(), '.pi/mesh/messages/host-bridge'); fs.mkdirSync(dir, { recursive: true });
  for (const recipient of ['host', 'failures']) fs.writeFileSync(path.join(dir, `.recipient-${Buffer.from(recipient).toString('hex')}.lock`), 'busy');
  f.event('double-busy'); const status = await formal(f, 'bridge_status');
  const row = diagnosticReceipt(status.details, incomingBridgeId(peer, 'double-busy'));
  assert.equal(row.admission.outcome, 'not-stored'); assert.equal(row.evidence.outcome, 'not-stored'); assert.match(row.evidence.error, /busy/);
  assert.equal(status.details.failureCount, 0); assert.equal(bridgeMessages().length, 0);
}, true));

for (const kind of ['pre-rename', 'post-visible', 'post-unknown']) test(`bridge second S3 failure file own native ${kind} retains diagnostic outcomes`, async () => fixture(async f => {
  await f.registered();
  const dir = path.join(bridgeSpoolRoot(), '.pi/mesh/messages/host-bridge'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.recipient-686f7374.lock'), 'busy');
  const rename = fs.renameSync, read = fs.readFileSync; let writeHits = 0, verificationHits = 0, unreadable = 0;
  const select = (file: string) => /\/failure-[^/]+\.json$/.test(file);
  const fault = kind === 'pre-rename' ? undefined : failDirectorySync(file => { if (!select(file)) return false; if (kind === 'post-unknown') unreadable = 2; return true; });
  if (kind === 'pre-rename') fs.renameSync = ((from: any, to: any) => { if (!writeHits && select(String(to))) { writeHits++; throw Object.assign(new Error('failure evidence native pre-rename EIO ' + '😀'.repeat(900)), { code: 'EIO' }); } return rename(from, to); }) as any;
  fs.readFileSync = ((file: any, ...args: any[]) => { if (unreadable && select(String(file))) { unreadable--; verificationHits++; throw Object.assign(new Error('failure verification EIO'), { code: 'EIO' }); } return (read as any)(file, ...args); }) as any; syncBuiltinESMExports();
  try { f.event(kind); assert.equal(writeHits + (fault?.hits ?? 0), 1); assert.equal(verificationHits, kind === 'post-unknown' ? 2 : 0); assert.equal(unreadable, 0); }
  finally { fault?.restore(); fs.renameSync = rename; fs.readFileSync = read; syncBuiltinESMExports(); }
  const status: any = (await formal(f, 'bridge_status')).details, row = diagnosticReceipt(status, incomingBridgeId(peer, kind));
  assert.equal(row.evidence.outcome, kind === 'pre-rename' ? 'not-stored' : kind === 'post-visible' ? 'stored-visible' : 'unknown');
  assert.match(row.evidence.error ?? row.evidence.durabilityWarning, /EIO|fsync/);
  const body = JSON.parse((await formal(f, 'bridge_status')).content[0].text);
  assert.deepEqual(diagnosticReceipt(body, incomingBridgeId(peer, kind)), row);
  console.log('BRIDGE_SECOND_NATIVE', JSON.stringify({ kind, primaryHits: writeHits + (fault?.hits ?? 0), verificationHits, totalNativeHits: writeHits + (fault?.hits ?? 0) + verificationHits, row }));
  assert.equal(status.failureCount, kind === 'pre-rename' ? 0 : 1);
}));

test('bridge second S3 failure capacity 65 retains attempted ID/outcome/error without deleting old files', async () => fixture(async f => {
  const rename = fs.renameSync; let hits = 0;
  fs.renameSync = ((from: any, to: any) => { if (/\/host-bridge\/in-[a-f0-9]+\.json$/.test(String(to))) { hits++; throw Object.assign(new Error('canonical native EIO'), { code: 'EIO' }); } return rename(from, to); }) as any; syncBuiltinESMExports();
  try {
    for (let i = 0; i < 64; i++) f.event(`cap-${i}`);
    const before = bridgeMessages(); await f.restart(); await f.registered(); f.event('cap-65'); assert.equal(hits, 65); assert.deepEqual(bridgeMessages(), before);
    const status: any = (await formal(f, 'bridge_status')).details, row = diagnosticReceipt(status, incomingBridgeId(peer, 'cap-65'));
    assert.equal(row.evidence.outcome, 'not-stored'); assert.match(row.evidence.error, /budget/); assert.equal(status.failureCount, 64);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
}));

test('bridge second S4 registered mesh status legal 16 long remote roots retains core with real orphan disabled/noRPC/restart', async () => fixture(async f => {
  await f.registered();
  const rename = fs.renameSync; let hits = 0;
  fs.renameSync = ((from: any, to: any) => { if (!hits && /\/host-bridge\/in-[a-f0-9]+\.json$/.test(String(to))) { hits++; throw new Error('orphan native rename EIO'); } return rename(from, to); }) as any; syncBuiltinESMExports();
  try { f.event('orphan'); assert.equal(hits, 1); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const failureId = bridgeMessages()[0]!.id;
  f.routes = Array.from({ length: 16 }, (_, i) => ({ ...f.routes[0]!, routeId: `long-${i}`, remoteTarget: { ...f.routes[0]!.remoteTarget, root: '/' + 'x'.repeat(4095) } })); f.write(false); f.rpc(false);
  assert.equal(loadMeshSettings(f.root).bridge.routes.length, 16);
  for (const restart of [false, true]) {
  if (restart) await f.restart();
  const status = await formal(f, 'bridge_status');
  for (const value of [status.details, JSON.parse(status.content[0].text)]) {
    assert.equal(value.evidenceCount, 0); assert.equal(value.failureCount, 1); assert.equal(value.local, null); assert.equal(value.enabled, false); assert.equal(value.totalLimit, 256); assert.equal(value.targetLimit, 64); assert.equal(value.totalUsed, restart ? 0 : 1); assert.equal(value.hintLimit, 8); assert.ok(value.diagnostics.length);
    assert.equal(value.routes.length, 16); assert.equal(value.routesOmitted, true); assert.match(value.routesReference, /mesh.settings.yaml|mesh\/settings.yaml/);
    assert.equal(value.routes[0].remoteTarget, undefined, 'never offer a truncated fake full target');
    if (!restart) assert.equal(diagnosticReceipt(value, incomingBridgeId(peer, 'orphan')).failureId, failureId);
  }
  const inbox = await formal(f, 'bridge_inbox'); assert.equal(inbox.details.entries[0].id, failureId);
  }
  // A foreign bus listener may throw a non-Error object. It is not a trusted
  // pre-bounded receipt and must not bypass the diagnostic/status budget.
  const off = f.bus.on(RPC_INFO, () => { throw { message: '😀'.repeat(40000) }; });
  try { await formal(f, 'bridge_status'); } finally { off(); }
  const bounded = await formal(f, 'bridge_status');
  assert.equal(bounded.details.failureCount, 1); assert.equal(JSON.parse(bounded.content[0].text).failureCount, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.details)) < 48 * 1024);
}));


test('bridge second S2 recovered native post-claim failures consume bounded live attempts without canonical writes', async () => fixture(async f => {
  const readDir = fs.readdirSync; let armed = false, hits = 0, claims = 0;
  fs.readdirSync = ((file: any, ...args: any[]) => { if (armed && String(file).endsWith('/messages/host-bridge')) { armed = false; hits++; throw Object.assign(new Error('post-claim native EIO'), { code: 'EIO' }); } return (readDir as any)(file, ...args); }) as any; syncBuiltinESMExports();
  try { for (let i = 0; i < 65; i++) if (f.event(`bounded-${i}`, {}, () => { armed = true; return true; }).claimed) claims++; }
  finally { fs.readdirSync = readDir; syncBuiltinESMExports(); }
  assert.equal(claims, 64); assert.equal(hits, 64);
  const status: any = await f.adapter.execute('bridge_status', {}, undefined, f.ctx); assert.equal(status.totalUsed, 64); assert.equal(status.evidenceCount, 0); assert.equal(status.failureCount, 64); assert.equal(messages(f.root, f.run.id).length, 0);
}));

for (const mode of ['new', 'duplicate', 'bad-json', 'repeated-read', 'trust', 'abort', 'session', 'stop', 'disabled']) test(`bridge third T1 existing readFile EIO ${mode} after successful claim`, async () => fixture(async f => {
  await f.registered();
  assert.equal(f.event('existing').claimed, true);
  const existingId = incomingBridgeId(peer, 'existing');
  await formal(f, 'bridge_ack', { messageId: existingId });
  const dir = path.join(bridgeSpoolRoot(), '.pi/mesh/messages/host-bridge');
  const file = path.join(dir, `${existingId}.json`);
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
  const before = snapshot(), mailbox = messages(f.root, f.run.id), validBytes = fs.readFileSync(file, 'utf8');
  const beforeStatus = (await formal(f, 'bridge_status')).details;
  const read = fs.readFileSync; let armed = false, hits = 0, claimed = false, postReads = 0;
  const fault = Object.assign(new Error('existing evidence readFile EIO'), { code: 'EIO', syscall: 'read', path: file });
  fs.readFileSync = ((name: any, ...args: any[]) => {
    if (claimed && String(name) === file) postReads++;
    if (armed && String(name) === file) {
      hits++; if (mode !== 'repeated-read') armed = false;
      if (mode === 'bad-json') return (read as any)(name, ...args);
      if (mode === 'trust') f.trusted(false);
      if (mode === 'abort') { const controller = new AbortController(); controller.abort(); f.ctx.signal = controller.signal; }
      if (mode === 'session') f.session('replacement');
      if (mode === 'stop') f.stopped(true);
      if (mode === 'disabled') f.write(false);
      throw fault;
    }
    return (read as any)(name, ...args);
  }) as any; syncBuiltinESMExports();
  const messageId = mode === 'duplicate' ? 'existing' : `third-${mode}`, id = incomingBridgeId(peer, messageId);
  try { assert.equal(f.event(messageId, {}, () => {
    if (mode === 'bad-json') { fs.writeFileSync(file, '{invalid JSON'); before[path.basename(file)] = '{invalid JSON'; }
    armed = claimed = true; return true;
  }).claimed, true); }
  finally { fs.readFileSync = read; syncBuiltinESMExports(); }
  // Old source cannot reach the second read: that count is itself a regression.
  assert.equal(hits, mode === 'repeated-read' ? 2 : 1);
  if (mode === 'duplicate') assert.equal(postReads, 2, 'healthy re-read proves dedup after the single fault');
  assert.deepEqual(messages(f.root, f.run.id), mailbox, 'no new canonical delivery/mailbox or ACK mutation');
  for (const [name, bytes] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), bytes);
  if (mode !== 'new') {
    assert.deepEqual(snapshot(), before, 'no new lock/failure/outcome files');
    if (mode === 'bad-json') fs.writeFileSync(file, validBytes); // fixture repairs its own corruption only after proving no bridge mutation
    f.trusted(true); f.ctx.signal = undefined; f.session(local.sessionId); f.stopped(false); f.write();
    const status = await formal(f, 'bridge_status'); assert.equal(status.details.totalUsed, beforeStatus.totalUsed); assert.equal(status.details.failureCount, beforeStatus.failureCount);
  } else {
    const failures = bridgeMessages().filter(row => row.id.startsWith('failure-')); assert.equal(failures.length, 1);
    assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), false); assert.equal(fs.existsSync(path.join(dir, `${id}-outcome.json`)), false);
    const evidence = JSON.parse(failures[0]!.content); assert.equal(evidence.inboxId, id); assert.equal(evidence.admission.code, 'EIO'); assert.equal(evidence.admission.stage, 'claimed-before-reservation'); assert.deepEqual(evidence.local, local);
    const status = await formal(f, 'bridge_status'); assert.equal(status.details.totalUsed, beforeStatus.totalUsed + 1); assert.equal(status.details.failureCount, beforeStatus.failureCount + 1);
    for (const state of ['enabled', 'disabled-noRPC', 'restart']) {
      if (state !== 'enabled') { f.write(false); f.rpc(false); }
      if (state === 'restart') await f.restart();
      const list = await formal(f, 'bridge_inbox'), selected = await formal(f, 'bridge_inbox', { messageId: id }), status = await formal(f, 'bridge_status');
      assert.ok(list.details.entries.some((row: any) => row.id === failures[0]!.id)); assert.equal(selected.details.count, 1); assert.equal(JSON.parse(selected.details.entries[0].content).inboxId, id);
      for (const value of [status.details, JSON.parse(status.content[0].text)]) { assert.equal(value.failureCount, 1); assert.equal(value.evidenceCount, 1); assert.equal(value.totalUsed, state === 'restart' ? 0 : beforeStatus.totalUsed + 1); assert.deepEqual(value.local, state === 'enabled' ? local : null); }
    }
  }
  console.log('BRIDGE_THIRD_READ', JSON.stringify({ mode, id, hits, postReads, claimed: true, oldFilesUnchanged: true, newFailures: mode === 'new' ? 1 : 0 }));
}));
