import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getEventListeners } from "node:events";
import { randomBytes } from "node:crypto";
import { failDirectorySync } from "../support/atomic-fault.ts";

import { MeshManager, type MeshRun } from "../../src/manager.ts";
import { FleetView } from "../../src/fleet-view.ts";
import { FleetLimiter } from "../../src/fleet-limiter.ts";
import { defaultMeshSettings } from "../../src/settings.ts";
import { emptyUsage } from "../../src/runtime-utils.ts";
import { atomicWrite, attemptResultFile, messages, putGrowth, putMessage, runFile, storeMessages } from "../../src/store.ts";
import { createMeshControlTool } from "../../src/control-extension.ts";
import type { AgentDefinition } from "../../src/agents.ts";
import type { SubagentRunOptions } from "../../src/subagent-runtime.ts";

// Scheduler fault/gate tests use an explicitly simulated runtime. Git, leases,
// checkpoints, mailbox, Fleet and Manager are real. Real SDK cases are separate.
const agent: AgentDefinition = { name: "local", description: "local", source: "bundled", filePath: "local.md", systemPrompt: "Local", tools: [], allowedSubagents: "all" };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(fn: () => boolean) { for (let n = 0; n < 600 && !fn(); n++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn(), "condition settled within 3s"); }
function git(root: string, ...args: string[]) { const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
const result = (output = "ok", error?: string) => ({ exitCode: error ? 1 : 0, signal: null, output, stderr: "", usage: { ...emptyUsage(), input: 3, output: 2, turns: 1 }, error, stopReason: error ? "error" as const : "completed" as const });
async function fixture(fn: (fx: { root: string; manager: MeshManager; internal: any; starts: SubagentRunOptions[]; manager2(): MeshManager; limiter: FleetLimiter }) => Promise<void>, worktree = false, enabled = false, concurrency = 1) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-lifecycle-")));
  const managers: MeshManager[] = []; const limiter = new FleetLimiter(concurrency);
  const manager2 = () => { const manager = new MeshManager(() => agent, { ...defaultMeshSettings, mailboxNotifications: enabled }, limiter, undefined, "default", worktree); managers.push(manager); return manager; };
  const manager = manager2(), internal = manager as any, starts: SubagentRunOptions[] = [];
  internal.subagentRuntime.start = (_agent: AgentDefinition, options: SubagentRunOptions) => { starts.push(options); return { completion: Promise.resolve(result()), ready: Promise.resolve({ persisted: false }), close: async () => {}, abort() {}, steer() {}, conversation: () => "" }; };
  if (worktree) { git(root, "init"); fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(root, "base.txt"), "base"); git(root, "add", "."); git(root, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "-m", "base"); }
  try { await fn({ root, manager, internal, starts, manager2, limiter }); }
  finally {
    await Promise.allSettled(managers.map((m) => m.shutdown()));
    if (worktree) for (const m of managers) for (const run of m.list()) for (const node of run.nodes) for (const state of [...(node.worktreeHistory ?? []), ...(node.worktree ? [node.worktree] : [])]) fs.rmSync(state.path, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const tasks = [{ id: "a", agent: "local", task: "a" }, { id: "b", agent: "local", task: "b", dependsOn: ["a"] }];

test("pause-drain-resume waits for finally/close and concurrent resumes coalesce", async () => fixture(async ({ root, manager, internal, limiter }) => {
  const completion = deferred<ReturnType<typeof result>>(), close = deferred(); let starts = 0, closing = false;
  internal.subagentRuntime.start = () => { starts++; return { completion: starts === 1 ? completion.promise : Promise.resolve(result()), close: async () => { if (starts === 1) { closing = true; await close.promise; } }, abort() {}, steer() {} }; };
  const first = manager.start({ cwd: root, tasks, maxConcurrency: 1 }); await until(() => starts === 1);
  const run = manager.list()[0]!; manager.pause(run.id);
  const resumed = manager.resume(run.id); assert.equal(manager.resume(run.id), resumed);
  completion.resolve(result()); await until(() => closing);
  assert.equal(run.status, "paused"); assert.equal(starts, 1); assert.equal(limiter.active, 1);
  assert.ok(fs.existsSync(path.join(root, ".pi", "mesh", "leases", run.id, "owner.json")));
  close.resolve(); await first; await resumed;
  assert.equal(starts, 2); assert.equal(run.status, "succeeded"); assert.equal(limiter.active, 0);
}));

test("drained pause cancel is immediately terminal; recover converges cancelling with zero interrupted nodes", async () => fixture(async ({ root, manager, manager2 }) => {
  const run = manager.create({ cwd: root, tasks }); manager.pause(run.id); manager.cancel(run.id);
  assert.equal(run.status, "cancelled");
  const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")); disk.status = "cancelling"; atomicWrite(runFile(root, run.id), disk);
  const other = manager2(); other.recover(root); assert.equal(other.get(run.id)?.status, "cancelled");
  assert.ok(other.get(run.id)?.nodes.every((node) => node.status === "cancelled"));
}));

test("node cancel immediately removes a Fleet waiter and launches no child", async () => fixture(async ({ root, manager, starts, limiter }) => {
  const release = await limiter.acquire(); const pending = manager.start({ cwd: root, tasks: [tasks[0]!] });
  await until(() => limiter.queued === 1); manager.cancel(manager.list()[0]!.id, "a");
  assert.equal(limiter.queued, 0); release(); const run = await pending;
  assert.equal(run.nodes[0]?.status, "cancelled"); assert.equal(starts.length, 0); assert.equal(limiter.active, 0);
}));

test("cancel retains shared quota and lease through a gated close", async () => fixture(async ({ root, manager, internal, manager2, limiter }) => {
  const finish = deferred<ReturnType<typeof result>>(), close = deferred(); let closing = false;
  internal.subagentRuntime.start = () => ({ completion: finish.promise, abort: () => finish.resolve(result("partial", "cancelled")), close: async () => { closing = true; await close.promise; } });
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => internal.subagents.get(manager.list()[0]!.id)?.size === 1);
  const run = manager.list()[0]!; manager.cancel(run.id); await until(() => closing);
  assert.equal(limiter.active, 1); assert.throws(() => manager2().recover(root), /already owned/);
  close.resolve(); await pending; assert.equal(limiter.active, 0);
}));

test("paused shutdown drains and captures the unique worktree before marking node paused", async () => fixture(async ({ root, manager, internal }) => {
  const finish = deferred<ReturnType<typeof result>>(); let launched = false;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { launched = true; fs.writeFileSync(path.join(opts.cwd, "saved.txt"), "saved"); return { completion: finish.promise, abort: () => finish.resolve(result("partial", "cancelled")), close: async () => {} }; };
  const pending = manager.start({ cwd: root, worktree: true, tasks: [tasks[0]!] }); await until(() => launched);
  const run = manager.list()[0]!; manager.pause(run.id); await manager.shutdown(); await pending;
  const node = run.nodes[0]!; assert.equal(run.status, "paused"); assert.equal(node.status, "paused");
  assert.ok(fs.existsSync(node.worktree!.path)); assert.ok(fs.existsSync(node.worktree!.handoffPath!));
  assert.equal(git(root, "show", `${node.worktree!.finalCommit}:saved.txt`), "saved");
  assert.throws(() => manager.create({ cwd: root, tasks }), /shut down/);
}, true));

test("real Git index.lock prevents succeeded attempt and launches zero downstream children", async () => fixture(async ({ root, manager, internal }) => {
  let starts = 0;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    starts++; fs.writeFileSync(path.join(opts.cwd, "unsaved.txt"), "unique");
    fs.writeFileSync(git(opts.cwd, "rev-parse", "--git-path", "index.lock"), "lock");
    return { completion: Promise.resolve(result()), close: async () => {}, abort() {} };
  };
  const run = await manager.start({ cwd: root, worktree: true, tasks }); const node = run.nodes[0]!;
  assert.equal(run.status, "failed"); assert.equal(node.status, "failed"); assert.equal(starts, 1); assert.equal(run.nodes[1]?.status, "skipped");
  assert.equal(JSON.parse(fs.readFileSync(node.attemptResultPath!, "utf8")).status, "failed");
  assert.equal(fs.readFileSync(path.join(node.worktree!.path, "unsaved.txt"), "utf8"), "unique");
}, true));

for (const route of ["auto", "retry_failed", "recover"] as const) test(`${route} inherits own commit and delivers full multi-attempt patch/range (no new retry changes)`, async () => fixture(async ({ root, manager, internal, manager2 }) => {
  let starts = 0;
  const start = (_a: unknown, opts: SubagentRunOptions) => {
    starts++;
    if (starts === 1) fs.writeFileSync(path.join(opts.cwd, "earlier.txt"), "earlier");
    else { assert.equal(fs.readFileSync(path.join(opts.cwd, "earlier.txt"), "utf8"), "earlier"); assert.match(opts.prompt, /Current cwd:/); }
    return { completion: Promise.resolve(result(starts === 1 ? "repair" : "done", starts === 1 ? "first failure" : undefined)), close: async () => {}, abort() {} };
  };
  internal.subagentRuntime.start = start;
  let run = await manager.start({ cwd: root, worktree: true, tasks: [{ ...tasks[0]!, retries: route === "auto" ? 1 : 0 }] });
  if (route === "retry_failed") run = await manager.retryFailed(run.id);
  if (route === "recover") {
    const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")); disk.status = "running"; disk.nodes[0].status = "running";
    fs.rmSync(attemptResultFile(root, run.id, "a", 1)); atomicWrite(runFile(root, run.id), disk);
    const restored = manager2(); (restored as any).subagentRuntime.start = start; restored.recover(root); run = await restored.resumeRecovered(run.id);
  }
  const node = run.nodes[0]!; assert.equal(run.status, "succeeded"); assert.equal(starts, 2);
  assert.equal(node.worktree!.baseCommit, node.worktreeHistory![0]!.finalCommit);
  assert.notEqual(node.worktree!.handoffBaseCommit, node.worktree!.baseCommit);
  assert.match(fs.readFileSync(node.worktree!.patchPath!, "utf8"), /earlier.txt/);
  const handoff = JSON.parse(fs.readFileSync(node.worktree!.handoffPath!, "utf8"));
  assert.equal(handoff.commitRange, `${node.worktree!.handoffBaseCommit}..${node.worktree!.finalCommit}`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-full-patch-")); git(root, "worktree", "add", "--detach", target, handoff.baseCommit);
  try { git(target, "apply", node.worktree!.patchPath!); assert.equal(fs.readFileSync(path.join(target, "earlier.txt"), "utf8"), "earlier"); }
  finally { git(root, "worktree", "remove", "--force", target); }
}, true));

test("two Managers fence stale cancel/grow/reacquire; recover never replaces a local live object", async () => fixture(async ({ root, manager, internal, manager2 }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id);
  // Complete a pause loop so its lease is released, then take two paused snapshots.
  (internal as any).releaseLease(run.id);
  const other = manager2(); other.recover(root);
  const done = deferred<ReturnType<typeof result>>(); internal.subagentRuntime.start = () => ({ completion: done.promise, close: async () => {}, abort: () => done.resolve(result()) });
  const resumed = manager.resume(run.id); await until(() => internal.subagents.get(run.id)?.size === 1);
  assert.throws(() => other.cancel(run.id), /owned|revision/); assert.throws(() => other.grow(run.id, "a", [{ id: "bad", agent: "local", task: "bad" }]), /owned|revision/);
  manager.recover(root); assert.equal(manager.get(run.id), run);
  done.resolve(result()); await resumed;
  assert.throws(() => other.cancel(run.id), /revision/); assert.equal(JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")).status, "succeeded");
}));

test("lease loss aborts/drains the old execution without writing new owner checkpoint or artifacts", async () => fixture(async ({ root, manager, internal, limiter }) => {
  const done = deferred<ReturnType<typeof result>>(), close = deferred(); let aborted = false, closing = false;
  internal.subagentRuntime.start = () => ({ completion: done.promise, close: async () => { closing = true; await close.promise; }, abort: () => { aborted = true; done.resolve(result("old")); } });
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); const rejected = assert.rejects(pending, /ownership|revision/);
  await until(() => internal.subagents.get(manager.list()[0]!.id)?.size === 1); const run = manager.list()[0]!;
  const file = runFile(root, run.id), disk = JSON.parse(fs.readFileSync(file, "utf8")); disk.revision += 10; atomicWrite(file, disk);
  const before = fs.readFileSync(file, "utf8"); await until(() => aborted && closing); assert.equal(limiter.active, 1);
  close.resolve(); await rejected; assert.equal(limiter.active, 0); assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(attemptResultFile(root, run.id, "a", 1)), false);
  assert.throws(() => manager.cancel(run.id), /recover/);
}));

for (const fault of ["output", "attempt", "checkpoint"] as const) test(`${fault} write failure cannot publish success or delete the only worktree`, async () => fixture(async ({ root, manager, internal }) => {
  const persist = internal.persist.bind(manager); let starts = 0;
  internal.persist = (run: MeshRun) => { if (fault === "checkpoint" && run.nodes.some((node) => node.status === "succeeded")) throw new Error("injected checkpoint fault"); persist(run); };
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    starts++; fs.writeFileSync(path.join(opts.cwd, "unique.txt"), "unique");
    if (fault !== "checkpoint") { const file = path.join(root, ".pi", "mesh", "artifacts", opts.mesh!.runId, "a", "attempt-1", fault === "output" ? "output.md" : "attempt-result.json"); fs.mkdirSync(file, { recursive: true }); }
    return { completion: Promise.resolve(result()), close: async () => {}, abort() {} };
  };
  const run = await manager.start({ cwd: root, worktree: true, tasks });
  assert.equal(run.status, "failed"); assert.equal(run.nodes[0]?.status, "failed"); assert.equal(starts, 1);
  assert.ok(fs.existsSync(run.nodes[0]!.worktree!.path)); assert.ok(fs.existsSync(run.nodes[0]!.worktree!.handoffPath!));
  assert.match(run.nodes[0]!.error!, /delivery failed/);
  if (fault === "checkpoint") assert.equal(JSON.parse(fs.readFileSync(run.nodes[0]!.attemptResultPath!, "utf8")).status, "failed");
}, true));

test("admission checkpoint failure releases lease and never starts runtime", async () => fixture(async ({ root, manager, internal, starts }) => {
  internal.persist = () => { throw new Error("admission fault"); };
  assert.throws(() => manager.create({ cwd: root, tasks }), /admission fault/);
  assert.equal(manager.list().length, 0); assert.equal(starts.length, 0); assert.equal(internal.leases.size, 0);
}));

test("pure worktree removal failure is only a warning after valid handoff", async () => fixture(async ({ root, manager, internal }) => {
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    fs.writeFileSync(path.join(opts.cwd, "kept.txt"), "kept"); git(root, "worktree", "lock", opts.cwd);
    return { completion: Promise.resolve(result()), close: async () => {}, abort() {} };
  };
  const run = await manager.start({ cwd: root, worktree: true, tasks: [tasks[0]!] }); const state = run.nodes[0]!.worktree!;
  assert.equal(run.status, "succeeded"); assert.equal(state.phase, "captured"); assert.match(state.cleanupError!, /Cleanup warning/);
  assert.ok(fs.existsSync(state.handoffPath!)); assert.ok(fs.existsSync(state.path));
}, true));

test("stale pending growth may be denied; final decision never clears a manual pause", async () => fixture(async ({ root, manager, internal }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id);
  putGrowth(root, { id: "stale", runId: run.id, requester: "missing", requesterAttempt: 99, baseRevision: 1, reason: "stale", tasks: [], createdAt: Date.now(), status: "proposed" });
  assert.throws(() => manager.decideGrowth(run.id, "stale", "approve"), /stale/);
  assert.equal(manager.decideGrowth(run.id, "stale", "deny"), false); assert.equal(run.status, "paused"); assert.equal(run.manualPause, true);
  assert.equal(internal.loops.size, 0);
}));

test("paused draining attempt may status/inbox/ack old mail, but not send/grow; stale attempts always fenced", async () => fixture(async ({ root, manager, internal }) => {
  const done = deferred<ReturnType<typeof result>>(); internal.subagentRuntime.start = () => ({ completion: done.promise, close: async () => {}, abort: () => done.resolve(result()) });
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => internal.subagents.get(manager.list()[0]!.id)?.size === 1);
  const run = manager.list()[0]!; manager.pause(run.id);
  putMessage(root, { id: "old", runId: run.id, from: "host", displayFrom: "claimed child", source: "host", to: "a", content: "old mail", senderAttempt: 0, replyTo: "original", createdAt: 1 });
  const tool = createMeshControlTool(root, run.id, "a", 1);
  await tool.execute("t", { action: "status" }); const inbox = await tool.execute("t", { action: "inbox" });
  assert.equal(inbox.details.inbox[0].senderAttempt, 0); assert.equal(inbox.details.inbox[0].replyTo, "original"); assert.equal(inbox.details.inbox[0].source, "host");
  await tool.execute("t", { action: "ack", messageId: "old" }); assert.ok(messages(root, run.id)[0]?.ackedAt);
  await assert.rejects(tool.execute("t", { action: "send", to: "host", content: "no" }), /Paused/);
  await assert.rejects(tool.execute("t", { action: "grow", tasks: [], reason: "no" }), /Paused/);
  await assert.rejects(createMeshControlTool(root, run.id, "a", 0).execute("t", { action: "inbox" }), /identity/);
  done.resolve(result()); await pending;
}));

test("mixed-quota broadcast returns honest per-recipient stored/error receipts; notification failure cannot undo storage", async () => fixture(async ({ root, manager }) => {
  const run = manager.create({ cwd: root, tasks }); manager.pause(run.id);
  putMessage(root, { id: "full", runId: run.id, from: "host", to: "a", content: "12345", createdAt: 1 });
  const receipt = await storeMessages(root, ["a", "b"].map((to) => ({ id: `send-${to}`, runId: run.id, from: "host", to, content: "ok", createdAt: 2 })), { payloadMaxBytes: 5, recipientUnreadMaxBytes: 5 }, () => { throw new Error("callback failure"); });
  assert.equal(receipt.partial, true); assert.equal(receipt.stored, 1); assert.equal(receipt.receipts[0]?.stored, false); assert.match(receipt.receipts[1]!.notificationError!, /callback failure/);
  assert.deepEqual(messages(root, run.id).map((message) => message.id).sort(), ["full", "send-b"]);
}));

for (const enabled of [false, true]) test(`mailbox notifications ${enabled ? "opt-in" : "default-off"}: coalesced bounded active hints never resurrect cancelled nodes`, async () => fixture(async ({ root, manager, internal }) => {
  const done = deferred<ReturnType<typeof result>>(); let steers = 0;
  internal.subagentRuntime.start = () => ({ completion: done.promise, close: async () => {}, abort: () => done.resolve(result()), steer: () => steers++ });
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => internal.subagents.get(manager.list()[0]!.id)?.size === 1);
  const run = manager.list()[0]!, message = { id: "hint", runId: run.id, from: "host", to: "a", content: "mail", createdAt: 1 };
  for (let n = 0; n < 100; n++) manager.notifyMessageStored(message); await tick(); assert.equal(steers, enabled ? 1 : 0);
  for (let n = 0; n < 20; n++) { manager.notifyMessageStored(message); await tick(); } assert.equal(steers, enabled ? 8 : 0);
  manager.pause(run.id); manager.notifyMessageStored(message); await tick(); assert.equal(steers, enabled ? 8 : 0);
  manager.cancel(run.id, "a"); await pending; manager.notifyMessageStored(message); await tick(); assert.equal(steers, enabled ? 8 : 0);
  assert.equal(run.nodes[0]?.attempt, 1); assert.equal(run.nodes[0]?.status, "cancelled");
}, false, enabled));

test("retry usage is accumulated and claimed exactly once with rollback after claim persistence failure", async () => fixture(async ({ root, manager, internal }) => {
  let count = 0; internal.subagentRuntime.start = () => ({ completion: Promise.resolve(result("answer", ++count === 1 ? "retry" : undefined)), close: async () => {}, abort() {} });
  const run = await manager.start({ cwd: root, tasks: [{ ...tasks[0]!, retries: 1 }] });
  assert.equal(run.nodes[0]?.attemptUsage?.input, 3); assert.equal(run.nodes[0]?.usage?.input, 6); assert.equal(run.usage?.input, 6);
  const persist = internal.persist; internal.persist = () => { throw new Error("claim failure"); };
  assert.throws(() => manager.claimUsage(run.id), /claim failure/); assert.equal(run.unclaimedUsage?.input, 6); internal.persist = persist;
  assert.equal(manager.claimUsage(run.id)?.input, 6); assert.equal(manager.claimUsage(run.id), undefined);
}));


test("untrusted Host rejects automatic worktree/setupHook before Git or child side effects", async () => fixture(async ({ root, manager, starts }) => {
  assert.throws(() => manager.create({ cwd: root, worktree: true, tasks }), /Host project trust/);
  assert.throws(() => manager.create({ cwd: root, worktreeSetupHook: "ignored.sh", tasks }), /Host project trust/);
  assert.equal(starts.length, 0); assert.equal(fs.existsSync(path.join(root, ".pi", "mesh")), false);
}));

test("trusted automatic Git helpers disable implicit fsmonitor/post-commit/external diff/textconv hooks", async () => fixture(async ({ root, manager, internal }) => {
  const marker = path.join(root, ".git", "implicit-marker");
  const script = path.join(root, ".git", "implicit.sh");
  fs.writeFileSync(script, `#!/bin/sh\nprintf implicit >> '${marker}'\n`, { mode: 0o700 });
  fs.copyFileSync(script, path.join(root, ".git", "hooks", "post-commit"));
  git(root, "config", "core.fsmonitor", script); git(root, "config", "diff.external", script);
  git(root, "config", "diff.fixture.textconv", script);
  fs.writeFileSync(path.join(root, ".git", "info", "attributes"), "*.txt diff=fixture\n");
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    fs.writeFileSync(path.join(opts.cwd, "captured.txt"), "capture");
    return { completion: Promise.resolve(result()), close: async () => {}, abort() {} };
  };
  const run = await manager.start({ cwd: root, worktree: true, tasks: [tasks[0]!] });
  assert.equal(run.status, "succeeded"); assert.equal(fs.existsSync(marker), false);
  assert.equal(git(root, "config", "core.fsmonitor"), script, "command-local overrides never modify repository config");
}, true));

test("pause drains Fleet waiters without starting a child or waiting for unrelated quota", async () => fixture(async ({ root, manager, limiter, starts }) => {
  const release = await limiter.acquire();
  try {
    const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => limiter.queued === 1);
    manager.pause(manager.list()[0]!.id); const run = await pending;
    assert.equal(limiter.queued, 0); assert.equal(starts.length, 0); assert.equal(run.nodes[0]?.status, "paused");
    manager.cancel(run.id); assert.equal(run.status, "cancelled");
  } finally { release(); }
}));

test("notification callbacks fence a stale execution attempt even before its delayed completion", async () => fixture(async ({ root, manager, internal }) => {
  const done = deferred<ReturnType<typeof result>>(); let steers = 0;
  internal.subagentRuntime.start = () => ({ completion: done.promise, close: async () => {}, abort: () => done.resolve(result()), steer: () => steers++ });
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => internal.subagents.get(manager.list()[0]!.id)?.size === 1);
  const run = manager.list()[0]!; run.nodes[0]!.attempt++;
  manager.notifyMessageStored({ id: "late", runId: run.id, from: "host", to: "a", content: "late", createdAt: 1 });
  await tick(); assert.equal(steers, 0); run.nodes[0]!.attempt--; done.resolve(result()); await pending;
}, false, true));

test("persistent final checkpoint fault rejects completion, drains maps and retains worktree evidence", async () => fixture(async ({ root, manager, internal, limiter }) => {
  const persist = internal.persist.bind(manager); let failed = false;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { fs.writeFileSync(path.join(opts.cwd, "last.txt"), "last"); return { completion: Promise.resolve(result()), close: async () => {}, abort() {} }; };
  internal.persist = (run: MeshRun) => { if (run.nodes.some((node) => node.status === "succeeded")) failed = true; if (failed) throw new Error("persistent disk fault"); persist(run); };
  await assert.rejects(manager.start({ cwd: root, worktree: true, tasks }), /persistent disk fault/);
  const run = manager.list()[0]!; assert.notEqual(run.nodes[0]?.status, "succeeded"); assert.equal(run.nodes[1]?.attempt, 0);
  assert.ok(fs.existsSync(run.nodes[0]!.worktree!.path)); assert.ok(fs.existsSync(run.nodes[0]!.worktree!.handoffPath!));
  assert.equal(limiter.active, 0); assert.equal(internal.loops.size, 0); assert.equal(internal.executions.size, 0); assert.equal(internal.leases.size, 0);
}, true));

test("execution close rejection is failed evidence, not an unhandled cleanup promise or leaked quota", async () => fixture(async ({ root, manager, internal, limiter }) => {
  internal.subagentRuntime.start = () => ({ completion: Promise.resolve(result()), close: async () => { throw new Error("close fault"); }, abort() {} });
  const run = await manager.start({ cwd: root, tasks });
  assert.equal(run.status, "failed"); assert.match(run.nodes[0]!.error!, /close failed/); assert.equal(run.nodes[1]?.attempt, 0);
  assert.equal(limiter.active, 0); assert.equal(internal.nodeControllers.size, 0); assert.equal(internal.executions.size, 0);
}));

test("retry commit range includes both failed-attempt and final-attempt files", async () => fixture(async ({ root, manager, internal }) => {
  let count = 0;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    count++; fs.writeFileSync(path.join(opts.cwd, count === 1 ? "earlier.txt" : "later.txt"), "saved");
    return { completion: Promise.resolve(result("repair", count === 1 ? "retry" : undefined)), close: async () => {}, abort() {} };
  };
  const run = await manager.start({ cwd: root, worktree: true, tasks: [{ ...tasks[0]!, retries: 1 }] }); const state = run.nodes[0]!.worktree!;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-range-")); git(root, "worktree", "add", "--detach", target, state.handoffBaseCommit!);
  try {
    git(target, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "cherry-pick", `${state.handoffBaseCommit}..${state.finalCommit}`);
    assert.equal(fs.readFileSync(path.join(target, "earlier.txt"), "utf8"), "saved"); assert.equal(fs.readFileSync(path.join(target, "later.txt"), "utf8"), "saved");
  } finally { git(root, "worktree", "remove", "--force", target); }
}, true));

test("writer fanin remains explicit and tampered saved branch cannot become a retry base", async () => fixture(async ({ root, manager, internal }) => {
  let starts = 0;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    starts++; fs.writeFileSync(path.join(opts.cwd, `${opts.mesh!.nodeId}.txt`), "saved");
    return { completion: Promise.resolve(result()), close: async () => {}, abort() {} };
  };
  const run = await manager.start({ cwd: root, worktree: true, tasks: [tasks[0]!, { id: "b", agent: "local", task: "b" }, { id: "c", agent: "local", task: "c", dependsOn: ["a", "b"] }] });
  assert.equal(starts, 2); assert.match(run.nodes[2]!.error!, /integration: true/);
  // Explicit failed retry still enforces multi-writer integration, not just first attempts.
  await manager.retryFailed(run.id); assert.equal(starts, 2); assert.match(run.nodes[2]!.error!, /integration: true/);
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { fs.writeFileSync(path.join(opts.cwd, "own.txt"), "own"); return { completion: Promise.resolve(result("bad", "retry me")), close: async () => {}, abort() {} }; };
  const own = await manager.start({ cwd: root, worktree: true, tasks: [tasks[0]!] }); const previous = own.nodes[0]!.worktree!;
  git(root, "branch", "-f", previous.branch, previous.handoffBaseCommit!); await manager.retryFailed(own.id);
  assert.equal(own.status, "failed"); assert.match(own.nodes[0]!.error!, /branch no longer matches/);
}, true));

test("explicit setup hook failure preserves its changes and starts no child", async () => fixture(async ({ root, manager, starts }) => {
  const hook = path.join(root, "setup.sh"); fs.writeFileSync(hook, "#!/bin/sh\nprintf setup > setup-output.txt\nexit 1\n", { mode: 0o700 });
  git(root, "add", "setup.sh"); git(root, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "-m", "explicit hook");
  const run = await manager.start({ cwd: root, worktree: true, worktreeSetupHook: hook, tasks: [tasks[0]!] });
  assert.equal(run.status, "failed"); assert.equal(starts.length, 0);
  assert.match(run.nodes[0]!.error!, /Setup worktree preserved/);
  const state = run.nodes[0]!.worktree!; assert.equal(git(root, "show", `${state.finalCommit}:setup-output.txt`), "setup"); assert.ok(fs.existsSync(state.handoffPath!));
}, true));

test("large binary handoff bypasses spawnSync stdout buffer without truncating the patch", async () => fixture(async ({ root, manager, internal }) => {
  const content = randomBytes(2 * 1024 * 1024);
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { fs.writeFileSync(path.join(opts.cwd, "large.bin"), content); return { completion: Promise.resolve(result()), close: async () => {}, abort() {} }; };
  const run = await manager.start({ cwd: root, worktree: true, tasks: [tasks[0]!] }); assert.equal(run.status, "succeeded");
  const state = run.nodes[0]!.worktree!, target = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-large-patch-")); git(root, "worktree", "add", "--detach", target, state.handoffBaseCommit!);
  assert.ok(fs.statSync(state.patchPath!).size > 1024 * 1024);
  try { git(target, "apply", state.patchPath!); assert.deepEqual(fs.readFileSync(path.join(target, "large.bin")), content); }
  finally { git(root, "worktree", "remove", "--force", target); }
}, true));

test("post-rename admission failure removes the unconfirmed checkpoint and releases its lease", async () => fixture(async ({ root, manager, internal, starts }) => {
  const persist = internal.persist.bind(manager); let id = "";
  internal.persist = (run: MeshRun) => { id = run.id; persist(run); throw new Error("directory fsync failure after rename"); };
  assert.throws(() => manager.create({ cwd: root, tasks }), /directory fsync/);
  assert.equal(starts.length, 0); assert.equal(manager.list().length, 0); assert.equal(internal.leases.size, 0);
  assert.equal(fs.existsSync(runFile(root, id)), false);
}));

// Review regressions: these must fail against the pre-review implementation.
for (const fault of ["final", "claim"] as const) test(`review real post-rename ${fault} fault compensates owned checkpoint`, async () => fixture(async ({ root, manager, internal, manager2 }) => {
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { fs.writeFileSync(path.join(opts.cwd, "unique-review.txt"), "keep"); return { completion: Promise.resolve(result()), close: async () => {}, abort() {} }; };
  const injection = failDirectorySync((file) => {
    if (!file.includes("/runs/")) return false;
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    if (fault === "claim") return !disk.unclaimedUsage;
    if (disk.nodes[0].status !== "succeeded") return false;
    assert.equal(JSON.parse(fs.readFileSync(attemptResultFile(root, disk.id, "a", 1), "utf8")).status, "succeeded", "successful receipt already staged before final checkpoint");
    assert.equal(internal.revisions.get(disk.id), disk.revision - 1, "real rename happened before persist updated its revision map");
    return true;
  });
  // Claim injection must be installed after execution (admission also has no usage).
  if (fault === "claim") injection.restore();
  let run: MeshRun;
  try { run = await manager.start({ cwd: root, worktree: true, tasks: fault === "final" ? tasks : [tasks[0]!] }); }
  finally { injection.restore(); }
  if (fault === "final") {
    assert.equal(injection.hits, 1); assert.equal(run.nodes[0]?.status, "failed"); assert.equal(run.nodes[1]?.attempt, 0);
    assert.ok(fs.existsSync(run.nodes[0]!.worktree!.path));
    assert.equal(JSON.parse(fs.readFileSync(attemptResultFile(root, run.id, "a", 1), "utf8")).status, "failed");
    const other = manager2(); other.recover(root); assert.notEqual(other.get(run.id)?.nodes[0]?.status, "succeeded");
  } else {
    const claimFault = failDirectorySync((file) => file === runFile(root, run.id));
    try { assert.throws(() => manager.claimUsage(run.id), /fsync/); assert.equal(claimFault.hits, 1); } finally { claimFault.restore(); }
    const other = manager2(); other.recover(root); assert.equal(other.claimUsage(run.id)?.input, 3); assert.equal(other.claimUsage(run.id), undefined);
  }
}, true));

for (const reason of ["cancel", "failfast"] as const) test(`review ${reason} retry waits for terminal-visible gated close and singleflights`, async () => fixture(async ({ root, manager, internal }) => {
  const gate = deferred(), finish = deferred<ReturnType<typeof result>>(); let starts = 0, closing = false;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    starts++; const first = opts.mesh!.attempt === 1, main = opts.mesh!.nodeId === "a";
    return { completion: first && main ? finish.promise : Promise.resolve(result("sibling", first ? "failfast trigger" : undefined)), abort: () => finish.resolve(result("cancel", "cancel")), close: async () => { if (first && main) { closing = true; await gate.promise; } } };
  };
  const first = manager.start({ cwd: root, tasks: reason === "cancel" ? [tasks[0]!] : [tasks[0]!, { id: "sibling", agent: "local", task: "fail" }], failFast: reason === "failfast", maxConcurrency: 2 }); await until(() => starts >= 1);
  const run = manager.list()[0]!;
  if (reason === "cancel") manager.cancel(run.id, undefined, "operator");
  await until(() => closing && ["cancelled", "failed"].includes(run.status));
  let retry!: Promise<MeshRun>;
  try { retry = manager.retryFailed(run.id); const retry2 = manager.retryFailed(run.id); await tick(); assert.equal(run.nodes[0]?.attempt, 1); assert.notEqual(run.nodes[0]?.status, "queued"); assert.notEqual(run.status, "running"); assert.equal(starts, reason === "cancel" ? 1 : 2); assert.equal(retry, retry2); }
  finally { gate.resolve(); }
  await first; await retry; assert.equal(run.epoch, 2); assert.equal(run.status, "succeeded");
}, false, false, 2));

for (const source of ["unknown", "user"] as const) test(`review ${source} stop cannot be reopened by ordinary retry, including recovery`, async () => fixture(async ({ root, manager, starts, manager2 }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id); manager.cancel(run.id, undefined, source);
  await assert.rejects(async () => manager.retryFailed(run.id), /user|authorization/i); assert.equal(starts.length, 0);
  const other = manager2(); other.recover(root); await assert.rejects(async () => other.retryFailed(run.id), /user|authorization/i);
}));

for (const status of ["succeeded", "queued", "paused"] as const) test(`review unconfirmed ${status} receipt recovers actual usage once independently of delivery`, async () => fixture(async ({ root, manager, internal, manager2 }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); const node = run.nodes[0]!;
  node.status = "running"; node.attempt = 1; internal.touch(run); internal.releaseLease(run.id);
  atomicWrite(attemptResultFile(root, run.id, node.id, 1), { schema: "pi-mesh.attempt-result/v1", runId: run.id, nodeId: node.id, attempt: 1, committedRevision: run.revision + 1, status, finishedAt: Date.now(), exitCode: 0, signal: null, stderrTail: "", usage: result().usage });
  const other = manager2(); other.recover(root); assert.notEqual(other.get(run.id)?.nodes[0]?.status, "succeeded"); assert.equal(other.get(run.id)?.usage?.input, 3);
  other.recover(root); assert.equal(other.get(run.id)?.usage?.input, 3); assert.equal(other.claimUsage(run.id)?.input, 3); assert.equal(other.claimUsage(run.id), undefined);
  (other as any).subagentRuntime.start = () => ({ completion: Promise.resolve(result()), close: async () => {}, abort() {} });
  await other.resumeRecovered(run.id); assert.equal(other.get(run.id)?.usage?.input, 6); assert.equal(other.claimUsage(run.id)?.input, 3); other.recover(root); assert.equal(other.claimUsage(run.id), undefined);
}));

test("review malformed checkpoint isolation keeps evidence and visible diagnostics", async () => fixture(async ({ root, manager, internal, manager2 }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id); internal.releaseLease(run.id);
  const bad = ["{broken", JSON.stringify({ ...run, id: "null-node", nodes: [null] }), JSON.stringify({ ...run, id: "bad-shape", maxConcurrency: "oops" })];
  const files = ["bad-json", "null-node", "bad-shape"].map((id) => runFile(root, id)); files.forEach((file, i) => fs.writeFileSync(file, bad[i]!));
  const other = manager2(); assert.doesNotThrow(() => other.recover(root)); assert.equal(other.list().length, 1); assert.equal(other.get(run.id)?.status, "paused");
  assert.ok(other.diagnostics.length >= 3); files.forEach((file, i) => { assert.equal(fs.readFileSync(file, "utf8"), bad[i]); assert.ok(other.diagnostics.some((d) => d.includes(file))); });
}));

test("review post-rename broadcast receipt separates stored-visible durability and notification warnings", async () => fixture(async ({ root, manager }) => {
  const run = manager.create({ cwd: root, tasks }); manager.pause(run.id);
  putMessage(root, { id: "full-review", runId: run.id, from: "host", to: "a", content: "12345", createdAt: 1 });
  const fault = failDirectorySync((file) => file.endsWith("visible-review.json"));
  try {
    const receipt = await storeMessages(root, ["a", "b"].map((to) => ({ id: to === "a" ? "not-stored-review" : "visible-review", runId: run.id, from: "host", to, content: "ok", createdAt: 2 })), { payloadMaxBytes: 5, recipientUnreadMaxBytes: 5 }, () => { throw new Error("notification-only"); });
    assert.equal(fault.hits, 1); assert.equal(receipt.stored, 1); assert.equal(receipt.receipts[1]?.stored, true); assert.match(receipt.receipts[1]!.durabilityWarning!, /fsync/); assert.match(receipt.receipts[1]!.notificationError!, /notification-only/);
    assert.equal(receipt.receipts[0]?.outcome, "not-stored"); assert.equal(receipt.receipts[1]?.outcome, "stored-visible"); assert.equal(messages(root, run.id).length, 2);
  } finally { fault.restore(); }
}));

for (const via of ["user", "signal"] as const) test(`review fresh ${via} cancellation wins over retry drain authorization`, async () => fixture(async ({ root, manager, internal }) => {
  const finish = deferred<ReturnType<typeof result>>(), gate = deferred(); let starts = 0, closing = false;
  internal.subagentRuntime.start = () => { starts++; return { completion: finish.promise, abort: () => finish.resolve(result("cancel", "cancel")), close: async () => { closing = true; await gate.promise; } }; };
  const first = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => starts === 1);
  const run = manager.list()[0]!; manager.cancel(run.id, undefined, via === "user" ? "user" : "operator"); await until(() => closing && run.status === "cancelled");
  const controller = new AbortController();
  const retry = via === "user" ? manager.retryFailedFromUser(run.id) : manager.retryFailed(run.id, controller.signal);
  const rejected = assert.rejects(retry, /cancellation|cancel|authorization/i);
  const version = run.cancelVersion!, epoch = run.epoch;
  if (via === "user") assert.equal(manager.cancel(run.id, undefined, "user"), true, "pending user authorization remains cancellable even though old run is terminal"); else controller.abort();
  assert.equal(run.status, "cancelled", "new cancellation never changes old terminal state");
  assert.equal(run.cancelVersion, version + 1); assert.equal(run.epoch, epoch);
  const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")); assert.equal(disk.status, "cancelled"); assert.equal(disk.cancelVersion, version + 1); assert.equal(disk.autoContinueBlocked, true);
  gate.resolve(); await first; await rejected;
  assert.equal(starts, 1); assert.equal(run.autoContinueBlocked, true); assert.equal(run.cancelSource, via === "user" ? "user" : "unknown");
  await assert.rejects(async () => manager.retryFailed(run.id), /authorization/i);
}));

test("review user-stopped node does not prevent unrelated failed node's legal retry", async () => fixture(async ({ root, manager, internal }) => {
  const finish = deferred<ReturnType<typeof result>>(); let starts = 0;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { starts++; return { completion: opts.mesh!.nodeId === "a" ? finish.promise : Promise.resolve(result("b", opts.mesh!.attempt === 1 ? "failure" : undefined)), abort: () => finish.resolve(result("stopped", "cancel")), close: async () => {} }; };
  const pending = manager.start({ cwd: root, tasks: [tasks[0]!, { id: "b", agent: "local", task: "b" }] }); await until(() => starts === 1);
  const run = manager.list()[0]!; manager.cancel(run.id, "a", "user"); await pending;
  await manager.retryFailed(run.id); assert.equal(run.nodes[0]?.status, "cancelled"); assert.equal(run.nodes[0]?.attempt, 1); assert.equal(run.nodes[1]?.status, "succeeded"); assert.equal(run.nodes[1]?.attempt, 2);
  await assert.rejects(async () => manager.retryFailed(run.id), /authorization/i);
}));

test("review old cancelled checkpoint with unknown provenance stays locked", async () => fixture(async ({ root, manager, internal, manager2 }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id); manager.cancel(run.id);
  const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")); delete disk.autoContinueBlocked; delete disk.cancelSource; delete disk.cancelVersion;
  atomicWrite(runFile(root, run.id), disk); internal.releaseLease(run.id);
  const other = manager2(); other.recover(root); await assert.rejects(async () => other.retryFailed(run.id), /authorization/i);
  (other as any).subagentRuntime.start = () => ({ completion: Promise.resolve(result()), close: async () => {}, abort() {} });
  await other.retryFailedFromUser(run.id); assert.equal(other.get(run.id)?.status, "succeeded");
}));

for (const corrupt of ["status", "dependency", "usage", "attempt", "cycle", "oversize"] as const) test(`review invalid ${corrupt} checkpoint is diagnosed without executing or replacing safe reference`, async () => fixture(async ({ root, manager, internal, manager2 }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id); internal.releaseLease(run.id);
  const other = manager2(); other.recover(root); const safe = other.get(run.id);
  const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8"));
  if (corrupt === "status") disk.nodes[0].status = "launch-anything";
  if (corrupt === "dependency") disk.nodes[0].dependsOn = ["missing"];
  if (corrupt === "usage") disk.usage = { ...emptyUsage(), input: -1 };
  if (corrupt === "attempt") disk.nodes[0].attempt = "1";
  if (corrupt === "cycle") disk.nodes[0].dependsOn = ["a"];
  if (corrupt === "oversize") disk.extra = "x".repeat(16 * 1024 * 1024);
  atomicWrite(runFile(root, run.id), disk); const before = fs.readFileSync(runFile(root, run.id));
  assert.doesNotThrow(() => other.recover(root)); assert.equal(other.get(run.id), safe); assert.ok(other.diagnostics.some((d) => d.includes(runFile(root, run.id)))); assert.deepEqual(fs.readFileSync(runFile(root, run.id)), before);
}));

test("review post-rename ownership loss never compensates over a foreign payload", async () => fixture(async ({ root, manager, internal }) => {
  let foreign = "", target = "";
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => { fs.writeFileSync(path.join(opts.cwd, "foreign-review.txt"), "keep"); return { completion: Promise.resolve(result()), close: async () => {}, abort() {} }; };
  const fault = failDirectorySync((file) => {
    if (!file.includes("/runs/")) return false;
    const disk = JSON.parse(fs.readFileSync(file, "utf8")); if (disk.nodes[0].status !== "succeeded") return false;
    const leaseFile = path.join(root, ".pi", "mesh", "leases", disk.id, "owner.json"); const owner = JSON.parse(fs.readFileSync(leaseFile, "utf8")); owner.token = "foreign-owner"; fs.writeFileSync(leaseFile, JSON.stringify(owner));
    disk.revision += 100; disk.status = "paused"; disk.nodes[0].status = "running"; disk.foreignEvidence = "do not overwrite";
    foreign = JSON.stringify(disk); target = file; fs.writeFileSync(file, foreign); return true;
  });
  try { await assert.rejects(manager.start({ cwd: root, tasks, worktree: true }), /ownership|revision/); assert.equal(fault.hits, 1); assert.equal(fs.readFileSync(target, "utf8"), foreign); assert.ok(fs.existsSync(manager.list()[0]!.nodes[0]!.worktree!.path)); assert.equal(manager.list()[0]!.nodes[1]?.attempt, 0); }
  finally { fault.restore(); }
}, true));


test("review actual Fleet stop callback persists user provenance and cannot restart a paused queued child", async () => fixture(async ({ root, manager, starts }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id);
  const fleet = new FleetView(); (fleet as any).meshManager = manager;
  try {
    const record = (fleet as any).records()[0]; assert.ok(record); assert.equal(record.stop(), true);
    assert.equal(run.nodes[0]?.cancelSource, "user"); assert.equal(run.nodes[0]?.autoContinueBlocked, true);
    assert.equal(JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")).nodes[0].cancelSource, "user");
    await manager.resume(run.id); assert.equal(starts.length, 0); await assert.rejects(async () => manager.retryFailed(run.id), /authorization/i);
  } finally { fleet.dispose(); }
}));


test("review user cancellation revokes ordinary failfast retry while old failed epoch is terminal-visible and close-gated", async () => fixture(async ({ root, manager, internal }) => {
  const gate = deferred(), finish = deferred<ReturnType<typeof result>>(); let starts = 0, closing = false;
  internal.subagentRuntime.start = (_a: unknown, opts: SubagentRunOptions) => {
    starts++; const id = opts.mesh!.nodeId;
    return { completion: id === "a" ? finish.promise : Promise.resolve(result(id, id === "bad" ? "failfast" : undefined)), abort: () => finish.resolve(result("cancelled", "cancelled")), close: async () => { if (id === "a") { closing = true; await gate.promise; } } };
  };
  const first = manager.start({ cwd: root, maxConcurrency: 3, failFast: true, tasks: [tasks[0]!, { id: "bad", agent: "local", task: "bad" }, { id: "done", agent: "local", task: "done" }] });
  const run = manager.list()[0]!; await until(() => closing && run.status === "failed");
  assert.equal(run.nodes[2]?.status, "succeeded"); const statuses = run.nodes.map((n) => n.status), epoch = run.epoch;
  const retry = manager.retryFailed(run.id); assert.equal(manager.retryFailed(run.id), retry);
  const rejected = assert.rejects(retry, /new cancellation|authorization/i);
  const version = run.cancelVersion ?? 0;
  assert.equal(manager.cancel(run.id, undefined, "user"), true);
  assert.equal(run.status, "failed"); assert.deepEqual(run.nodes.map((n) => n.status), statuses); assert.equal(run.cancelVersion, version + 1);
  const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")); assert.equal(disk.status, "failed"); assert.equal(disk.nodes[2].status, "succeeded"); assert.equal(disk.cancelVersion, version + 1); assert.equal(disk.autoContinueBlocked, true);
  gate.resolve(); await first; await rejected;
  assert.equal(starts, 3); assert.equal(run.epoch, epoch); assert.equal(run.nodes[2]?.attempt, 1);
  await assert.rejects(async () => manager.retryFailed(run.id), /authorization/i);
}, false, false, 3));

for (const already of [false, true]) test(`second review joining retry signal ${already ? "already aborted" : "aborts after join"} revokes shared authorization`, async () => fixture(async ({ root, manager, internal }) => {
  const gate = deferred(), finish = deferred<ReturnType<typeof result>>(); let starts = 0, closing = false;
  internal.subagentRuntime.start = () => { starts++; return { completion: starts === 1 ? finish.promise : Promise.resolve(result()), abort: () => finish.resolve(result("stop", "stop")), close: async () => { if (starts === 1) { closing = true; await gate.promise; } } }; };
  const first = manager.start({ cwd: root, tasks: [tasks[0]!] }); await until(() => starts === 1);
  const run = manager.list()[0]!; manager.cancel(run.id, undefined, "operator"); await until(() => closing && run.status === "cancelled");
  const firstSignal = new AbortController();
  const retry = manager.retryFailed(run.id, firstSignal.signal), outcome = retry.then(() => undefined, e => e);
  const signal = new AbortController(), version = run.cancelVersion!, epoch = run.epoch;
  assert.notEqual(firstSignal.signal, signal.signal);
  try {
    if (already) signal.abort();
    assert.equal(manager.retryFailed(run.id, signal.signal), retry);
    if (!already) signal.abort();
    const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8"));
    assert.equal(disk.cancelVersion, version + 1); assert.equal(disk.cancelSource, "unknown"); assert.equal(disk.autoContinueBlocked, true); assert.equal(disk.status, "cancelled");
  } finally { gate.resolve(); await first; await outcome; }
  assert.match(String(await outcome), /cancel|authorization/i); assert.equal(starts, 1); assert.equal(run.epoch, epoch);
  assert.equal(firstSignal.signal.aborted, false);
  assert.equal(getEventListeners(firstSignal.signal, "abort").length, 0);
  assert.equal(getEventListeners(signal.signal, "abort").length, 0);
}));

for (const route of ["retry", "resume"] as const) test(`second review ordered recover reaction preserves canonical pending ${route}`, async () => fixture(async ({ root, manager, internal }) => {
  const gate = deferred(), finish = deferred<ReturnType<typeof result>>(), next = deferred<ReturnType<typeof result>>(); let starts = 0, closing = false;
  internal.subagentRuntime.start = () => { const index = ++starts; return { completion: index === 1 ? finish.promise : next.promise, abort: () => (index === 1 ? finish : next).resolve(result("stop", "stop")), close: async () => { if (index === 1) { closing = true; await gate.promise; } } }; };
  const run = manager.create({ cwd: root, tasks }); const first = manager.startCreated(run.id);
  // Register on the actual loop, before continuation registration, not start()'s wrapper.
  const recovered = first.then(() => manager.recover(root));
  await until(() => starts === 1);
  if (route === "retry") manager.cancel(run.id, undefined, "operator"); else { manager.pause(run.id); finish.resolve(result()); }
  await until(() => closing && (route === "retry" ? run.status === "cancelled" : run.status === "paused"));
  const pending = route === "retry" ? manager.retryFailed(run.id) : manager.resume(run.id);
  try {
    gate.resolve(); await recovered; await until(() => starts === 2);
    assert.equal(manager.get(run.id), run); assert.equal(manager.list()[0], run);
    assert.equal(internal.subagents.get(run.id).size, 1);
    assert.equal(JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")).status, run.status);
    assert.equal(manager.cancel(run.id, undefined, "user"), true); await pending;
    assert.equal(run.status, "cancelled"); assert.equal(manager.get(run.id)?.cancelSource, "user");
    assert.equal(JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")).cancelSource, "user");
  } finally { gate.resolve(); next.resolve(result()); await pending; }
}));

for (const escaped of ["\\", "\u0000"]) test(`second review serialized ${JSON.stringify(escaped)} growth refuses before topology commit and children`, async () => fixture(async ({ root, manager, internal, starts, manager2 }) => {
  internal.settings = { ...defaultMeshSettings, maxNodes: 128 };
  const batch = (offset: number) => Array.from({ length: 16 }, (_, i) => ({ id: `n${offset + i}`, agent: "local", task: "x" + escaped.repeat(65535) }));
  const run = manager.create({ cwd: root, maxNodes: 128, tasks: batch(0) }); manager.pause(run.id);
  let refused = false;
  for (let n = 16; n < 128; n += 16) {
    const before = fs.readFileSync(runFile(root, run.id)), count = run.nodes.length;
    try { manager.grow(run.id, "n0", batch(n)); }
    catch (error) { assert.match(String(error), /serialized|budget/i); assert.equal(run.nodes.length, count); assert.deepEqual(fs.readFileSync(runFile(root, run.id)), before); refused = true; break; }
  }
  assert.equal(refused, true); assert.equal(starts.length, 0);
  internal.releaseLease(run.id); const other = manager2(); other.recover(root); assert.equal(other.get(run.id)?.nodes.length, run.nodes.length);
}));

test("second review serialized create budget rejects control expansion without admission", async () => fixture(async ({ root, manager, internal, starts }) => {
  internal.settings = { ...defaultMeshSettings, maxNodes: 128 };
  assert.throws(() => manager.create({ cwd: root, maxNodes: 128, tasks: Array.from({ length: 32 }, (_, i) => ({ id: `n${i}`, agent: "local", task: "x" + "\u0000".repeat(65535) })) }), /serialized|budget/i);
  assert.equal(manager.list().length, 0); assert.equal(starts.length, 0); assert.equal(internal.leases.size, 0);
}));

test("second review runtime evidence persists recoverably with complete external evidence and oversized neighbor isolation", async () => fixture(async ({ root, manager, internal, manager2 }) => {
  const error = "unique-error" + "\u0000".repeat(1024 * 1024), output = "unique-output" + "\\".repeat(1024 * 1024);
  internal.subagentRuntime.start = () => ({ completion: Promise.resolve(result(output, error)), close: async () => {}, abort() {} });
  const run = await manager.start({ cwd: root, tasks: [tasks[0]!] });
  assert.equal(fs.readFileSync(run.nodes[0]!.outputPath!, "utf8"), output);
  assert.ok(fs.readFileSync(run.nodes[0]!.diagnosticPath!, "utf8").includes(error));
  assert.ok(fs.statSync(run.nodes[0]!.attemptResultPath!).size <= 1024 * 1024);
  const badFile = runFile(root, "oversized-neighbor"); fs.writeFileSync(badFile, " ".repeat(16 * 1024 * 1024 + 1));
  const other = manager2(); other.recover(root);
  assert.equal(other.get(run.id)?.status, "failed"); assert.ok(other.diagnostics.some(d => d.includes(badFile)));
  assert.equal(fs.statSync(badFile).size, 16 * 1024 * 1024 + 1);
}));


test("second review retry join cannot promote ordinary authority and removes non-aborted caller listeners", async () => fixture(async ({ root, manager }) => {
  const run = manager.create({ cwd: root, tasks: [tasks[0]!] }); manager.pause(run.id); manager.cancel(run.id, undefined, "user");
  const firstSignal = new AbortController(), secondSignal = new AbortController();
  const pending = manager.retryFailed(run.id, firstSignal.signal);
  assert.equal(manager.retryFailed(run.id, secondSignal.signal), pending);
  assert.equal(manager.retryFailedFromUser(run.id), pending, "joining user command does not promote an ordinary flight either");
  assert.equal(getEventListeners(secondSignal.signal, "abort").length, 1);
  await assert.rejects(pending, /authorization/i);
  assert.equal(getEventListeners(firstSignal.signal, "abort").length, 0); assert.equal(getEventListeners(secondSignal.signal, "abort").length, 0);
}));

test("second review growing history archives complete immutable chains while full Git handoffs stay intact", async () => fixture(async ({ root, manager, internal, manager2 }) => {
  let starts = 0;
  internal.subagentRuntime.start = (_agent: unknown, opts: SubagentRunOptions) => { fs.writeFileSync(path.join(opts.cwd, `change-${++starts}.txt`), "saved"); return { completion: Promise.resolve(result("saved", starts === 1 ? "retry" : undefined)), close: async () => {}, abort() {} }; };
  const run = await manager.start({ cwd: root, worktree: true, tasks: [{ ...tasks[0]!, retries: 1 }] }), node = run.nodes[0]!;
  assert.equal(node.worktreeHistory!.length, 2);
  const handoffs = node.worktreeHistory!.map(state => ({ file: state.handoffPath!, content: fs.readFileSync(state.handoffPath!, "utf8"), patch: fs.readFileSync(state.patchPath!, "utf8") }));
  internal.ensureLease(run);
  node.worktreeHistory = Array.from({ length: 1100 }, (_, index) => ({ ...node.worktreeHistory![index % 2]!, cleanupError: `unique-history-${index}` }));
  const fullHistory = structuredClone(node.worktreeHistory);
  internal.touch(run);
  const first = node.evidencePath!; assert.ok(first);
  assert.deepEqual(JSON.parse(fs.readFileSync(first, "utf8")).worktreeHistory, fullHistory);
  assert.equal(node.worktreeHistory!.length, 1);
  node.error = "second-unique-error" + "\u0000".repeat(100000); internal.touch(run);
  const next = JSON.parse(fs.readFileSync(node.evidencePath!, "utf8")); assert.equal(next.previous, first); assert.ok(next.error.startsWith("second-unique-error"));
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).worktreeHistory.length, 1100);
  for (const handoff of handoffs) assert.equal(fs.readFileSync(handoff.file, "utf8"), handoff.content);
  assert.match(handoffs[1]!.patch, /change-1.txt/); assert.match(handoffs[1]!.patch, /change-2.txt/);
  internal.releaseLease(run.id); const other = manager2(); other.recover(root); assert.equal(other.get(run.id)?.nodes[0]?.evidencePath, node.evidencePath);
}, true));

test("second review 128 admitted small tasks and repeated runtime growth keep every real checkpoint recoverable", async () => fixture(async ({ root, manager, internal, manager2 }) => {
  internal.settings = { ...defaultMeshSettings, maxNodes: 128 };
  const run = manager.create({ cwd: root, maxNodes: 128, tasks: [tasks[0]!] }); manager.pause(run.id);
  for (let i = 1; i < 128; i += 16) manager.grow(run.id, "a", Array.from({ length: Math.min(16, 128 - i) }, (_, n) => ({ id: `n${i + n}`, agent: "local", task: "small" })));
  let writes = 0;
  const persist = internal.persist.bind(manager);
  internal.persist = (value: MeshRun) => { persist(value); writes++; const disk = JSON.parse(fs.readFileSync(runFile(root, run.id), "utf8")); assert.equal(disk.revision, value.revision); assert.ok(fs.statSync(runFile(root, run.id)).size <= 16 * 1024 * 1024); };
  for (const node of run.nodes) {
    node.output = "output" + "\u0000".repeat(65536); node.error = "error" + "\\".repeat(65536);
    node.activity = { turns: 1, toolUses: 1, responseText: "response".repeat(12000), thinkingText: "thinking".repeat(12000), activeTools: ["read"], usage: emptyUsage() };
  }
  internal.touch(run); assert.equal(writes, 1);
  assert.ok(run.nodes.every(node => node.evidencePath && fs.existsSync(node.evidencePath)));
  internal.releaseLease(run.id); const other = manager2(); other.recover(root); assert.equal(other.get(run.id)?.nodes.length, 128); assert.equal(other.diagnostics.length, 0);
  for (const node of other.get(run.id)!.nodes) assert.equal(JSON.parse(fs.readFileSync(node.evidencePath!, "utf8")).output, "output" + "\u0000".repeat(65536));
  // Direct persist safety net rejects an externally mutated over-cap task set;
  // it cannot replace the previously recoverable checkpoint.
  internal.ensureLease(run); const before = fs.readFileSync(runFile(root, run.id)); const originals = run.nodes.map(n => n.task);
  for (const node of run.nodes) node.task = "x" + "\\".repeat(65535);
  assert.throws(() => internal.persist(run), /serialized.*budget/i); assert.deepEqual(fs.readFileSync(runFile(root, run.id)), before);
  run.nodes.forEach((node, index) => { node.task = originals[index]!; });
}));
