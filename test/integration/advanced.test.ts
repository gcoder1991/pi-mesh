import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { MeshManager, type MeshRun } from "../../src/manager.ts";
import { atomicWrite, putAttemptResult, putNodeOutput, runFile } from "../../src/store.ts";

const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };

function recoveredRun(cwd: string): MeshRun {
  const now = Date.now();
  return {
    schema: "pi-mesh.run/v2", id: "recovered", status: "running", cwd, operator: "graph", maxConcurrency: 1, maxNodes: 8,
    failFast: false, revision: 1, recoveryCount: 0, createdAt: now, updatedAt: now,
    nodes: [{ id: "a", agent: "worker", task: "work", dependsOn: [], cwd, retries: 0, attempt: 1, status: "running" }],
  };
}

test("recovers the same project through a canonical path after creation via symlink", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-real-root-"));
  const link = `${real}-link`;
  try {
    fs.symlinkSync(real, link);
    const manager = new MeshManager(() => agent);
    const run = manager.create({ cwd: link, tasks: [{ id: "a", agent: "worker", task: "a" }] });
    manager.pause(run.id);
    const recovered = new MeshManager(() => agent).recover(real);
    assert.equal(recovered.some((item) => item.id === run.id), true);
    assert.equal(recovered.find((item) => item.id === run.id)?.cwd, fs.realpathSync(real));
  } finally { fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); }
});

test("skips checkpoints whose recorded cwd no longer exists", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-stale-cwd-"));
  const missing = path.join(cwd, "missing");
  try {
    atomicWrite(runFile(cwd, "stale"), { ...recoveredRun(missing), id: "stale" });
    assert.deepEqual(new MeshManager(() => agent).recover(cwd), []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("recovers interrupted nodes as queued and checkpoints recovery", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-recover-"));
  try {
    atomicWrite(runFile(cwd, "recovered"), recoveredRun(cwd));
    const manager = new MeshManager(() => agent);
    const run = manager.recover(cwd)[0];
    assert.equal(run.recoveryCount, 1);
    assert.equal(run.nodes[0].status, "queued");
    assert.match(run.nodes[0].error!, /Recovered/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("recovers a terminal attempt result without rerunning the child", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-result-recover-"));
  try {
    const persisted = recoveredRun(cwd);
    const outputPath = putNodeOutput(cwd, persisted.id, "a", 1, "completed before crash");
    const resultPath = putAttemptResult(cwd, persisted.id, "a", 1, {
      schema: "pi-mesh.attempt-result/v1", runId: persisted.id, nodeId: "a", attempt: 1, status: "succeeded",
      startedAt: 10, finishedAt: 20, exitCode: 0, signal: null, stderrTail: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      outputPath, outputBytes: 22, outputTruncated: false,
    });
    atomicWrite(runFile(cwd, persisted.id), persisted);
    const manager = new MeshManager(() => agent);
    const run = manager.recover(cwd)[0];
    assert.equal(run.nodes[0].status, "succeeded");
    assert.equal(run.nodes[0].output, "completed before crash");
    assert.equal(run.nodes[0].attemptResultPath, resultPath);
    assert.equal(run.nodes[0].finishedAt, 20);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("rejects an attempt result whose identity does not match the checkpoint", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-bad-result-"));
  try {
    const persisted = recoveredRun(cwd);
    putAttemptResult(cwd, persisted.id, "a", 1, { schema: "pi-mesh.attempt-result/v1", runId: persisted.id, nodeId: "wrong", attempt: 1, status: "succeeded", finishedAt: 1 });
    atomicWrite(runFile(cwd, persisted.id), persisted);
    const manager = new MeshManager(() => agent);
    assert.throws(() => manager.recover(cwd), /Invalid attempt result state/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("recovery accepts queued retry evidence and requeues the interrupted node", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-retry-result-"));
  try {
    const persisted = recoveredRun(cwd);
    putAttemptResult(cwd, persisted.id, "a", 1, { schema: "pi-mesh.attempt-result/v1", runId: persisted.id, nodeId: "a", attempt: 1, status: "queued", finishedAt: 1, exitCode: 1, signal: null, stderrTail: "retry", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } });
    atomicWrite(runFile(cwd, persisted.id), persisted);
    const run = new MeshManager(() => agent).recover(cwd)[0];
    assert.equal(run.nodes[0].status, "queued");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("recovers a cancelling run as cancelled", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-cancelling-recover-"));
  try {
    const persisted = recoveredRun(cwd); persisted.status = "cancelling";
    atomicWrite(runFile(cwd, persisted.id), persisted);
    const run = new MeshManager(() => agent).recover(cwd)[0];
    assert.equal(run.status, "cancelled");
    assert.equal(run.nodes[0].status, "cancelled");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("recovers paused runs without leaving ghost running nodes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-paused-recover-"));
  try {
    const persisted = recoveredRun(cwd);
    persisted.status = "paused";
    atomicWrite(runFile(cwd, persisted.id), persisted);
    const manager = new MeshManager(() => agent);
    const run = manager.recover(cwd)[0];
    assert.equal(run.status, "paused");
    assert.equal(run.nodes[0].status, "paused");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("host-approved growth enforces the requester allowlist", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-grow-"));
  try {
    const run = recoveredRun(cwd);
    run.status = "paused";
    run.nodes[0].status = "paused";
    run.nodes[0].allowedSubagents = ["WORKER"];
    atomicWrite(runFile(cwd, run.id), run);
    const manager = new MeshManager(() => agent);
    manager.recover(cwd);
    const added = manager.grow(run.id, "a", [{ id: "review", agent: "worker", task: "review", dependsOn: ["a"] }]);
    assert.equal(added[0].dynamic, true);
    assert.equal(added[0].requestedBy, "a");
    assert.equal(manager.get(run.id)?.nodes.length, 2);
    assert.throws(() => manager.grow(run.id, "a", [{ id: "qa", agent: "qa", task: "qa" }]), /cannot grow agents: qa/);
    manager.get(run.id)!.nodes[0]!.status = "succeeded";
    assert.throws(() => manager.grow(run.id, "a", [{ id: "late", agent: "worker", task: "late" }]), /Requester a is not active/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("supervisor and mixture make the final task depend on all workers", () => {
  for (const operator of ["supervisor", "mixture"] as const) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mesh-${operator}-`));
    const manager = new MeshManager(() => agent);
    const run = manager.create({ cwd, operator, tasks: [
      { id: "a", agent: "worker", task: "a" }, { id: "b", agent: "worker", task: "b" }, { id: "judge", agent: "worker", task: "judge" },
    ] });
    manager.pause(run.id);
    assert.deepEqual(run.nodes[2].dependsOn, ["a", "b"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("sequence, reflection, and debate are stable bounded chains", () => {
  for (const operator of ["sequence", "reflection", "debate"] as const) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mesh-${operator}-`));
    const manager = new MeshManager(() => agent);
    const created = manager.create({ cwd, operator, tasks: [{ id: "a", agent: "worker", task: "a" }, { id: "b", agent: "worker", task: "b" }, { id: "c", agent: "worker", task: "c" }] });
    manager.pause(created.id);
    assert.deepEqual(created.nodes.map((node) => node.dependsOn), [[], ["a"], ["b"]]);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
