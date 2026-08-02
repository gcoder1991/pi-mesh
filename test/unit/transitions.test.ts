import assert from "node:assert/strict";
import test from "node:test";
import type { MeshNode, MeshRun } from "../../src/manager.ts";
import { transitionNode, transitionRun } from "../../src/transitions.ts";

const node = (status: MeshNode["status"]): MeshNode => ({ id: "n", agent: "worker", task: "x", dependsOn: [], cwd: "/tmp", retries: 0, attempt: 0, status });
const run = (status: MeshRun["status"]): MeshRun => ({ schema: "pi-mesh.run/v2", id: "r", status, cwd: "/tmp", maxConcurrency: 1, maxNodes: 1, failFast: false, operator: "graph", revision: 1, recoveryCount: 0, createdAt: 1, updatedAt: 1, nodes: [] });

test("lifecycle transitions are validated and terminal states are monotonic", () => {
  const active = node("queued");
  assert.equal(transitionNode(active, "running"), true);
  assert.equal(transitionNode(active, "succeeded"), true);
  assert.equal(transitionNode(active, "succeeded"), false);
  assert.throws(() => transitionNode(active, "failed"), /Invalid node transition/);

  const mesh = run("running");
  transitionRun(mesh, "cancelling");
  transitionRun(mesh, "cancelled");
  assert.throws(() => transitionRun(mesh, "running"), /Invalid run transition/);
});

test("seeded lifecycle chaos preserves terminal monotonicity", () => {
  const seed = Number(process.env.SEED ?? 20260801);
  let state = seed >>> 0;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  const nodes = Array.from({ length: 8 }, (_, index) => ({ ...node("queued"), id: `n${index}` }));
  const terminal = new Map<string, string>();
  for (let step = 0; step < 1000; step++) {
    const current = nodes[Math.floor(random() * nodes.length)]!;
    const before = current.status;
    const candidates: Record<MeshNode["status"], MeshNode["status"][]> = {
      queued: ["running", "paused", "cancelled", "skipped", "failed"], running: ["queued", "paused", "succeeded", "failed", "cancelled"],
      paused: ["queued", "cancelled", "failed"], succeeded: ["failed", "running"], failed: ["succeeded", "queued"], cancelled: ["succeeded", "running"], skipped: ["running", "succeeded"],
    };
    const next = candidates[before][Math.floor(random() * candidates[before].length)]!;
    try { transitionNode(current, next); } catch {}
    const committed = terminal.get(current.id);
    if (committed) assert.equal(current.status, committed, `seed=${seed} step=${step}`);
    else if (["succeeded", "failed", "cancelled", "skipped"].includes(current.status)) terminal.set(current.id, current.status);
  }
});
