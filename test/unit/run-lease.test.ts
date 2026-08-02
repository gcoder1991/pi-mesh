import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireRunLease, RunLeaseConflictError } from "../../src/run-lease.ts";
import { meshDir } from "../../src/store.ts";

test("run lease excludes another owner and releases by token", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-lease-"));
  try {
    const lease = acquireRunLease(cwd, "r1");
    assert.throws(() => acquireRunLease(cwd, "r1"), RunLeaseConflictError);
    assert.equal(lease.release(), true);
    assert.equal(acquireRunLease(cwd, "r1").release(), true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("run lease reclaims a demonstrably dead local owner", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-stale-lease-"));
  try {
    const dir = path.join(meshDir(cwd), "leases", "r1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({
      version: 1, token: "dead", runId: "r1", pid: 99999999, hostname: os.hostname(), acquiredAt: 1,
    }));
    const lease = acquireRunLease(cwd, "r1");
    assert.notEqual(lease.owner.token, "dead");
    assert.equal(lease.release(), true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
