import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { ackMessage, atomicWrite, growthProposals, messages, messageReceiptDetails, pruneMeshState, putGrowth, putMessage, readJson } from "../../src/store.ts";

test("durably sends and acknowledges mailbox messages", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-store-"));
  try {
    putMessage(cwd, { id: "m1", runId: "r1", from: "a", to: "b", content: "hello", createdAt: 1 });
    assert.equal(messages(cwd, "r1")[0].content, "hello");
    assert.equal(ackMessage(cwd, "r1", "m1", "a"), false);
    assert.equal(ackMessage(cwd, "r1", "m1", "b"), true);
    assert.ok(messages(cwd, "r1")[0].ackedAt);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("enforces mailbox payload and unread byte limits", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-mailbox-limits-"));
  try {
    const limits = { payloadMaxBytes: 5, recipientUnreadMaxBytes: 8 };
    putMessage(cwd, { id: "m1", runId: "r1", from: "a", to: "b", content: "hello", createdAt: 1 }, limits);
    assert.throws(() => putMessage(cwd, { id: "m2", runId: "r1", from: "a", to: "b", content: "toolong", createdAt: 2 }, limits), /payload exceeds 5/);
    assert.throws(() => putMessage(cwd, { id: "m3", runId: "r1", from: "a", to: "b", content: "four", createdAt: 3 }, limits), /unread mailbox exceeds 8/);
    assert.equal(ackMessage(cwd, "r1", "m1", "b"), true);
    putMessage(cwd, { id: "m3", runId: "r1", from: "a", to: "b", content: "four", createdAt: 3 }, limits);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("stale mailbox recipient locks fail closed until explicit quiescent repair", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-mailbox-stale-lock-"));
  try {
    const dir = path.join(cwd, ".pi", "mesh", "messages", "r1");
    const lock = path.join(dir, `.recipient-${Buffer.from("b").toString("hex")}.lock`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lock, "stale");
    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(lock, old, old);
    const delivery = { id: "m1", runId: "r1", from: "a", to: "b", content: "hello", createdAt: 1 }, limits = { payloadMaxBytes: 8, recipientUnreadMaxBytes: 8 };
    assert.throws(() => putMessage(cwd, delivery, limits), /busy.*stop all spool writers/);
    assert.equal(fs.readFileSync(lock, "utf8"), "stale");
    assert.equal(messages(cwd, "r1").length, 0);
    // This fixture has no other writer. Explicit operator repair, not age theft.
    fs.unlinkSync(lock);
    putMessage(cwd, delivery, limits);
    assert.equal(messages(cwd, "r1")[0]?.content, "hello");
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("does not steal an active mailbox recipient lock", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-mailbox-active-lock-"));
  try {
    const dir = path.join(cwd, ".pi", "mesh", "messages", "r1");
    const lock = path.join(dir, `.recipient-${Buffer.from("b").toString("hex")}.lock`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lock, "active");
    assert.throws(() => putMessage(cwd, { id: "m1", runId: "r1", from: "a", to: "b", content: "hello", createdAt: 1 }, { payloadMaxBytes: 8, recipientUnreadMaxBytes: 8 }), /mailbox is busy/);
    assert.equal(fs.existsSync(lock), true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("reports corrupted JSON instead of treating it as missing", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-corrupt-"));
  try {
    const file = path.join(cwd, "state.json");
    fs.writeFileSync(file, "{");
    assert.throws(() => readJson(file), /Invalid JSON state/);
    atomicWrite(file, { ok: true });
    assert.deepEqual(readJson(file), { ok: true });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("durably records growth decisions", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-growth-"));
  try {
    putGrowth(cwd, { id: "g1", runId: "r1", requester: "a", reason: "need review", tasks: [], status: "proposed", baseRevision: 1, requesterAttempt: 1, createdAt: 1 });
    const proposal = growthProposals<unknown[]>(cwd, "r1")[0];
    proposal.status = "denied";
    putGrowth(cwd, proposal);
    assert.equal(growthProposals(cwd, "r1")[0].status, "denied");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("prunes old terminal run state while preserving active runs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-prune-"));
  try {
    const root = path.join(cwd, ".pi", "mesh");
    for (const [id, status, finishedAt] of [["old", "succeeded", 1], ["new", "failed", Date.now()], ["active", "running", 1]] as const) {
      atomicWrite(path.join(root, "runs", `${id}.json`), { schema: "pi-mesh.run/v2", id, sessionId: "test", status, finishedAt, updatedAt: finishedAt, createdAt: 1, cwd, maxConcurrency: 1, maxNodes: 1, failFast: false, operator: "graph", revision: 1, recoveryCount: 0, nodes: [{ id: "a", agent: "worker", task: "fixture", dependsOn: [], cwd, retries: 0, attempt: 1, status: "succeeded" }] });
      fs.mkdirSync(path.join(root, "artifacts", id), { recursive: true });
    }
    assert.deepEqual(pruneMeshState(cwd, { retentionDays: 30, maxTerminalRuns: 10 }), { removedRuns: 1 });
    assert.equal(fs.existsSync(path.join(root, "runs", "old.json")), false);
    assert.equal(fs.existsSync(path.join(root, "artifacts", "old")), false);
    assert.equal(fs.existsSync(path.join(root, "runs", "new.json")), true);
    assert.equal(fs.existsSync(path.join(root, "runs", "active.json")), true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});


test("compact Mesh core receipts retain all 128 maximum-length IDs and warnings within 48KiB", () => {
  const receipts = Array.from({ length: 128 }, (_, i) => ({ to: `${i}`.padEnd(64, "x"), id: `${i}`.padEnd(36, "0"), stored: false, outcome: "stored-visible" as const, error: "e".repeat(65536), durabilityWarning: "d".repeat(65536), notificationError: "n".repeat(65536) }));
  const details = messageReceiptDetails({ receipts, stored: 0, partial: false, messages: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(details)) < 48 * 1024);
  assert.deepEqual(details.receipts.map(({ to, id, outcome }) => ({ to, id, outcome })), receipts.map(({ to, id, outcome }) => ({ to, id, outcome })));
  assert.ok(details.receipts.every(r => r.durabilityWarning && r.error && r.notificationError));
});


test("bridge third T1 readJson preserves native identity and distinguishes parse cause from missing", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "read-json-cause-")), file = path.join(cwd, "state.json");
  const read = fs.readFileSync; let hits = 0;
  const native = Object.assign(new Error("native read EIO"), { code: "EIO", syscall: "read", path: file });
  try {
    assert.equal(readJson(file), undefined); fs.writeFileSync(file, "{}");
    fs.readFileSync = ((target: any, ...args: any[]) => { if (String(target) === file) { hits++; throw native; } return (read as any)(target, ...args); }) as any; syncBuiltinESMExports();
    assert.throws(() => readJson(file), error => { assert.equal(error, native); return true; }); assert.equal(hits, 1);
    fs.readFileSync = read; syncBuiltinESMExports(); fs.writeFileSync(file, "{");
    assert.throws(() => readJson(file), (error: any) => { assert.match(error.message, /Invalid JSON state/); assert.ok(error.cause instanceof SyntaxError); assert.equal(error.code, undefined); return true; });
    assert.equal(fs.readFileSync(file, "utf8"), "{");
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
