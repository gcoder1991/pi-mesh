import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { failDirectorySync, mixedMessageFault } from "../support/atomic-fault.ts";

import registerPiMesh from "../../src/extension.ts";
import { MeshManager } from "../../src/manager.ts";
import { SubagentRuntime } from "../../src/subagent-runtime.ts";
import { emptyUsage } from "../../src/runtime-utils.ts";
import { messages, putMessage } from "../../src/store.ts";

// Real Host tool routing/Manager/store/notifier, with a simulated execution and
// fake ExtensionAPI, not a provider/session integration test.
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>((r) => { resolve = r; }); return { promise, resolve }; }
async function until(fn: () => boolean) { for (let n = 0; n < 500 && !fn(); n++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn()); }

test("Host send/broadcast share stored callbacks, display labels cannot impersonate child identity, trust refresh keeps one live Manager", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-"))), oldDir = process.env.PI_CODING_AGENT_DIR;
  const start = SubagentRuntime.prototype.start, notify = MeshManager.prototype.notifyMessageStored;
  const gate = deferred(), stored: any[] = []; let tool: any, starts = 0, steers = 0, trusted = true;
  const handlers = new Map<string, any>();
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-dir");
  try {
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "mesh"), { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mesh", "settings.yaml"), "mailboxNotifications: true\njoinMode: async\n");
    SubagentRuntime.prototype.start = function () { starts++; return { completion: gate.promise, close: async () => {}, abort: () => gate.resolve({ exitCode: 1, signal: null, output: "cancelled", stderr: "", usage: emptyUsage(), error: "cancelled" }), steer: () => steers++ } as any; };
    MeshManager.prototype.notifyMessageStored = function (message) { stored.push(message); notify.call(this, message); };
    registerPiMesh({ registerTool(value: any) { if (value.name === "mesh") tool = value; }, getAllTools: () => [], getCommands: () => [], events: { emit() {}, on: () => () => {} }, registerCommand() {}, registerShortcut() {}, sendMessage() {}, sendUserMessage() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
    const ctx: any = { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "host-mesh" }, modelRegistry: { getAvailable: () => [] } };
    const execute = (params: any) => tool.execute("host", params, undefined, undefined, ctx);
    await handlers.get("session_start")({}, ctx);
    const created = await execute({ action: "run", async: true, maxConcurrency: 1, tasks: [{ id: "a", agent: "worker", task: "running" }, { id: "b", agent: "worker", task: "queued", dependsOn: ["a"] }] });
    const runId = created.details.run.id; await until(() => starts === 1);
    trusted = false;
    await execute({ action: "status", runId }); assert.equal(starts, 1, "same root/session trust change cannot restore a second owner");
    const send = await execute({ action: "message_send", runId, from: "b", to: "a", content: "Host relay" });
    const broadcast = await execute({ action: "message_broadcast", runId, from: "a", content: "all" });
    assert.equal(send.details.stored, 1); assert.equal(broadcast.details.stored, 2, "display from does not remove that recipient");
    assert.equal(stored.length, 3); assert.ok(steers > 0); assert.equal(starts, 1);
    const spool = messages(root, runId); assert.ok(spool.every((message) => message.from === "host" && message.source === "host" && message.senderAttempt === undefined));
    assert.equal(spool[0]?.displayFrom, "b");
    await execute({ action: "cancel", runId }); await handlers.get("session_shutdown")();
    assert.equal(starts, 1);
  } finally {
    gate.resolve({ exitCode: 0, signal: null, output: "done", stderr: "", usage: emptyUsage() });
    await handlers.get("session_shutdown")?.();
    SubagentRuntime.prototype.start = start; MeshManager.prototype.notifyMessageStored = notify;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background Mesh notifications deduplicate epochs, paused is not completed and foreground does not notify twice", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-notify-"))), oldDir = process.env.PI_CODING_AGENT_DIR;
  const start = SubagentRuntime.prototype.start, sent: any[] = [], handlers = new Map<string, any>(); let tool: any, count = 0;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-dir");
  try {
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "mesh"), { recursive: true }); fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mesh", "settings.yaml"), "joinMode: async\n");
    const gates = [deferred(), deferred(), deferred()];
    SubagentRuntime.prototype.start = function () { const gate = gates[count++]!; return { completion: gate.promise, close: async () => {}, abort() {} } as any; };
    registerPiMesh({ registerTool(value: any) { if (value.name === "mesh") tool = value; }, getAllTools: () => [], getCommands: () => [], events: { emit() {}, on: () => () => {} }, registerCommand() {}, registerShortcut() {}, sendMessage(message: any) { sent.push(message); }, sendUserMessage() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
    const ctx: any = { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "notifications" }, modelRegistry: { getAvailable: () => [] } };
    const execute = (params: any) => tool.execute("host", params, undefined, undefined, ctx);
    const receipt = await execute({ action: "run", async: true, tasks: [{ id: "a", agent: "worker", task: "a" }, { id: "b", agent: "worker", task: "b", dependsOn: ["a"] }] }); const runId = receipt.details.run.id;
    await until(() => count === 1); await execute({ action: "pause", runId }); gates[0]!.resolve({ exitCode: 0, signal: null, output: "first", stderr: "", usage: emptyUsage() });
    await new Promise((r) => setTimeout(r, 80)); assert.equal(sent.length, 0);
    await Promise.all([execute({ action: "resume", runId }), execute({ action: "resume", runId })]); await until(() => count === 2);
    gates[1]!.resolve({ exitCode: 0, signal: null, output: "second", stderr: "", usage: emptyUsage() }); await until(() => sent.length === 1);
    assert.match(sent[0].details.ids[0], new RegExp(`mesh:${runId}:2:1\\.1`));
    const foreground = execute({ action: "run", tasks: [{ agent: "worker", task: "foreground" }] }); await until(() => count === 3);
    gates[2]!.resolve({ exitCode: 0, signal: null, output: "foreground", stderr: "", usage: { ...emptyUsage(), input: 7, turns: 1 } }); const completed = await foreground;
    assert.equal(completed.usage.input, 7); assert.equal(sent.length, 1);
    const status = await execute({ action: "status", runId: completed.details.run.id }); assert.equal(status.usage, undefined);
  } finally {
    await handlers.get("session_shutdown")?.(); SubagentRuntime.prototype.start = start;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review Host single delivery reports post-rename warning and only genuine no-UI command unlocks recovered user stop", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-review-host-")));
  const start = SubagentRuntime.prototype.start, stderr = console.error;
  const commands = new Map<string, any>(), handlers = new Map<string, any>(), diagnostics: string[] = [];
  let tool: any, starts = 0;
  const original = new MeshManager(() => ({ name: "worker", description: "fixture", source: "bundled", filePath: "fixture.md", systemPrompt: "fixture", tools: [] }), undefined, undefined, undefined, "review-host");
  try {
    const run = original.create({ cwd: root, tasks: [{ id: "a", agent: "worker", task: "stopped" }] }); original.pause(run.id); original.cancel(run.id, undefined, "user"); await original.shutdown();
    fs.writeFileSync(path.join(root, ".pi", "mesh", "runs", "bad-json.json"), "{bad");
    console.error = (...args) => { diagnostics.push(args.join(" ")); };
    SubagentRuntime.prototype.start = function () { starts++; return { completion: Promise.resolve({ exitCode: 0, signal: null, output: "authorized", stderr: "", usage: emptyUsage() }), close: async () => {}, abort() {} } as any; };
    registerPiMesh({ registerTool(value: any) { if (value.name === "mesh") tool = value; }, getAllTools: () => [], getCommands: () => [], events: { emit() {}, on: () => () => {} }, registerCommand(name: string, value: any) { commands.set(name, value); }, registerShortcut() {}, sendMessage() {}, sendUserMessage() { throw new Error("Must not ask model to authorize itself"); }, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
    const ctx: any = { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "review-host" }, modelRegistry: { getAvailable: () => [] } };
    const execute = (params: any) => tool.execute("host", params, undefined, undefined, ctx);
    await handlers.get("session_start")({}, ctx);
    assert.ok(diagnostics.some((d) => d.includes("bad-json.json"))); assert.equal(fs.readFileSync(path.join(root, ".pi", "mesh", "runs", "bad-json.json"), "utf8"), "{bad");
    await assert.rejects(execute({ action: "retry_failed", runId: run.id, userAuthorized: true }), /authorization/i); assert.equal(starts, 0);
    const fault = failDirectorySync((file) => file.includes("/messages/"));
    try {
      const delivery = await execute({ action: "message_send", runId: run.id, to: "a", content: "mail only" });
      assert.equal(fault.hits, 1); assert.equal(delivery.details.stored, 1); assert.equal(delivery.details.receipts[0].outcome, "stored-visible"); assert.match(delivery.details.receipts[0].durabilityWarning, /fsync/);
      assert.equal(messages(root, run.id).length, 1); assert.equal(starts, 0); assert.doesNotMatch(delivery.content[0].text, /retry only failed/);
    } finally { fault.restore(); }
    await commands.get("mesh").handler(`retry ${run.id}`, ctx);
    assert.equal(starts, 1); const status = await execute({ action: "status", runId: run.id }); assert.equal(status.details.run.status, "succeeded"); assert.equal(status.details.run.id, run.id);
    assert.ok(diagnostics.some((d) => d.includes("succeeded")));
  } finally { await handlers.get("session_shutdown")?.(); await original.shutdown(); SubagentRuntime.prototype.start = start; console.error = stderr; fs.rmSync(root, { recursive: true, force: true }); }
});

for (const route of ["Host", "child"] as const) for (const longWarning of [false, true]) test(`second review ${route} 32KiB broadcast preserves every mixed receipt${longWarning ? " with over-budget warnings" : ""}`, async () => {
  const { createMeshControlTool } = await import("../../src/control-extension.ts");
  const { defaultMeshSettings } = await import("../../src/settings.ts");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-large-receipts-")));
  const oldDir = process.env.PI_CODING_AGENT_DIR, handlers = new Map<string, any>(); let tool: any;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-dir");
  const manager = new MeshManager(() => ({ name: "worker", description: "fixture", source: "bundled", filePath: "fixture.md", systemPrompt: "fixture", tools: [] }), { ...defaultMeshSettings, recipientUnreadMaxBytes: 32768 });
  try {
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "mesh"), { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mesh", "settings.yaml"), "recipientUnreadMaxBytes: 32768\n");
    const run = manager.create({ cwd: root, tasks: ["source", "a", "b", "c", "d"].map(id => ({ id, agent: "worker", task: id })) });
    run.nodes[0]!.status = "running"; run.nodes[0]!.attempt = 1; (manager as any).touch(run); (manager as any).releaseLease(run.id);
    putMessage(root, { id: "full", runId: run.id, from: "host", to: "c", content: "x".repeat(32768), createdAt: 1 });
    if (route === "Host") registerPiMesh({ registerTool(value: any) { if (value.name === "mesh") tool = value; }, getAllTools: () => [], getCommands: () => [], events: { emit() {}, on: () => () => {} }, registerCommand() {}, registerShortcut() {}, sendMessage() {}, sendUserMessage() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
    const fault = mixedMessageFault(longWarning ? "warning".repeat(12000) : undefined);
    let delivery: any;
    try {
      delivery = route === "child" ? await createMeshControlTool(root, run.id, "source", 1).execute("t", { action: "broadcast", content: "z".repeat(32768) })
        : await tool.execute("t", { action: "message_broadcast", runId: run.id, content: "z".repeat(32768) }, undefined, undefined, { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "default" }, modelRegistry: { getAvailable: () => [] } });
      assert.equal(fault.hits, 2); assert.equal(fault.unreadable, 0);
    } finally { fault.restore(); }
    assert.ok(Buffer.byteLength(JSON.stringify(delivery.details)) <= 50 * 1024);
    assert.equal(delivery.details.messages, undefined, "no duplicated full bodies");
    const receipts = delivery.details.receipts; assert.equal(receipts.length, route === "Host" ? 5 : 4);
    for (const [to, outcome] of [["a", "stored-visible"], ["b", "unknown"], ["c", "not-stored"], ["d", "stored"]]) {
      const receipt = receipts.find((r: any) => r.to === to); assert.equal(receipt.outcome, outcome); assert.match(receipt.id, /^[a-f0-9-]{36}$/);
      if (to === "a") assert.ok(receipt.durabilityWarning);
      if (to === "b") assert.equal(receipt.stored, false);
      assert.equal(messages(root, run.id).some(m => m.id === receipt.id), to !== "c");
    }
    assert.match(delivery.content[0].text, /retry only not-stored.*unknown IDs/);
  } finally { await handlers.get("session_shutdown")?.(); await manager.shutdown(); if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; fs.rmSync(root, { recursive: true, force: true }); }
});
