import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatMeshTree, manageHerdrTree } from "../../src/herdr-tree.ts";

test("formats Mesh runs as an Astralink-style dependency tree", () => {
  const run: any = {
    id: "run-1", operator: "graph", status: "running", createdAt: 1_000, updatedAt: 2_000,
    nodes: [
      { id: "inspect", agent: "scout", task: "Find the root cause", dependsOn: [], status: "succeeded", retries: 0, attempt: 1, cwd: "/tmp", startedAt: 1_000, finishedAt: 2_000 },
      { id: "fix", agent: "worker", task: "Apply the fix", dependsOn: ["inspect"], status: "running", retries: 0, attempt: 1, cwd: "/tmp", startedAt: 2_000, activity: { turns: 2, toolUses: 3, responseText: "editing fleet view", activeTools: ["read", "replace"], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0 } } },
      { id: "review", agent: "reviewer", task: "Review the fix", dependsOn: ["fix", "inspect"], status: "queued", retries: 0, attempt: 0, cwd: "/tmp" },
    ],
  };
  const oldRun = { ...run, id: "old-run", status: "succeeded", updatedAt: -30_000, finishedAt: -30_000 };
  const output = formatMeshTree([oldRun, run], 5_000);
  assert.match(output, /PI-MESH TREE  ● 2 active/);
  assert.match(output, /▼ run-1 · graph · running · 1\/3 done/);
  assert.doesNotMatch(output, /old-run/);
  assert.match(output, /└─ ✓ inspect · scout/);
  assert.match(output, /└─ ● fix · worker · running · 3s · 1\.2k tok/);
  assert.match(output, /└─ ◦ review · reviewer · queued · also:inspect · wait:fix/);
  assert.match(output, /⎿ read, replace/);
});

test("opens, reports, and closes one Herdr left Mesh tree pane", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-herdr-tree-"));
  const calls: string[][] = [];
  try {
    const runHerdr = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "split") return { stdout: JSON.stringify({ pane: { pane_id: "w1:p9" } }), stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    };
    const opened = await manageHerdrTree("open", root, runHerdr);
    assert.equal(opened.ok, true, opened.message);
    assert.match(opened.message, /left pane w1:p9/);
    assert.deepEqual(calls[0]?.slice(0, 5), ["pane", "split", "--current", "--direction", "left"]);
    assert.match(calls.find((args) => args[1] === "run")?.[3] ?? "", /herdr-tree\.ts.*--runner.*--cwd/);

    const status = await manageHerdrTree("status", root, runHerdr);
    assert.match(status.message, /w1:p9 is open/);
    const closed = await manageHerdrTree("close", root, runHerdr);
    assert.match(closed.message, /Mesh runs were not stopped/);
    assert.ok(calls.some((args) => args.join(" ") === "pane close w1:p9"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
