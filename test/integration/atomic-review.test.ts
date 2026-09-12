import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { atomicWrite, atomicWriteCheckpoint, AtomicWriteError, storeMessages } from "../../src/store.ts";

for (const stage of ["open", "close", "cleanup"] as const) test(`review atomic post-rename directory ${stage} error is not swallowed and restores checkpoint`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-review-")), file = path.join(root, "state.json");
  atomicWrite(file, { old: true }); const original = fs.readFileSync(file);
  const rename = fs.renameSync, open = fs.openSync, close = fs.closeSync, rm = fs.rmSync;
  let renamed = false, hits = 0;
  fs.renameSync = ((from: any, to: any) => { rename(from, to); if (to === file) renamed = true; }) as typeof fs.renameSync;
  fs.openSync = ((name: any, flags: any, mode: any) => { if (!hits && renamed && stage === "open" && name === root && flags === "r") { hits++; throw new Error("directory open fault"); } return open(name, flags, mode); }) as typeof fs.openSync;
  fs.closeSync = (fd) => { const directory = fs.fstatSync(fd).isDirectory(); close(fd); if (!hits && renamed && directory && stage === "close") { hits++; throw new Error("directory close fault"); } };
  fs.rmSync = ((name: any, options: any) => { rm(name, options); if (!hits && renamed && stage === "cleanup" && String(name).endsWith(".tmp")) { hits++; throw new Error("temp cleanup fault"); } }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  try { assert.throws(() => atomicWriteCheckpoint(file, { new: true }), (e: any) => e instanceof AtomicWriteError && e.renamed && /fault/.test(e.message)); assert.equal(hits, 1); assert.deepEqual(fs.readFileSync(file), original); }
  finally { fs.renameSync = rename; fs.openSync = open; fs.closeSync = close; fs.rmSync = rm; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("review unknown mailbox visibility is explicit and is never safe-to-retry advice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-unknown-"));
  const rename = fs.renameSync, read = fs.readFileSync, sync = fs.fsyncSync;
  let written = "", hits = 0;
  fs.renameSync = ((from: any, to: any) => { rename(from, to); written = String(to); }) as typeof fs.renameSync;
  fs.fsyncSync = (fd) => { if (written && fs.fstatSync(fd).isDirectory()) { hits++; throw new Error("directory fsync unavailable"); } sync(fd); };
  fs.readFileSync = ((file: any, ...args: any[]) => { if (written && String(file) === written) throw new Error("visibility cannot be verified"); return (read as any)(file, ...args); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const sent = await storeMessages(root, [{ id: "uncertain", runId: "run", from: "host", to: "a", content: "mail", createdAt: 1 }], { payloadMaxBytes: 10, recipientUnreadMaxBytes: 10 });
    assert.equal(hits, 1); assert.equal(sent.receipts[0]?.outcome, "unknown"); assert.equal(sent.receipts[0]?.stored, false); assert.match(sent.receipts[0]!.error!, /unknown/);
    assert.equal(JSON.parse(read(written, "utf8")).id, "uncertain");
  } finally { fs.renameSync = rename; fs.readFileSync = read; fs.fsyncSync = sync; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("review scheduler admission post-rename error cannot restore an unacknowledged schedule", async () => {
  const { AgentScheduler } = await import("../../src/scheduler.ts");
  const { failDirectorySync } = await import("../support/atomic-fault.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-review-"));
  const scheduler = new AgentScheduler(root, "review", () => { throw new Error("must not execute"); });
  const fault = failDirectorySync((file) => file.includes("/schedules/"));
  try { assert.throws(() => scheduler.add({ name: "unacknowledged", schedule: "+60s", prompt: "no", agent: "worker" }), /fsync/); assert.equal(fault.hits, 1); assert.equal(scheduler.list().length, 0); }
  finally { fault.restore(); scheduler.dispose(); }
  const restored = new AgentScheduler(root, "review", () => {});
  try { assert.equal(restored.list().length, 0); } finally { restored.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
