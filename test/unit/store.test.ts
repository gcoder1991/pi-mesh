import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ackMessage, atomicWrite, growthProposals, messages, putGrowth, putMessage, readJson } from "../../src/store.ts";

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
