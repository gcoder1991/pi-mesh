import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { collectMeshTreeItems, MeshTreeComponent, openMeshTree } from "../../src/mesh-tree.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

function run(now = Date.now()): any {
  return {
    id: "run-12345678", operator: "graph", status: "running", createdAt: now - 5_000, updatedAt: now,
    nodes: [
      { id: "inspect", agent: "scout", task: "Find the root cause", dependsOn: [], status: "succeeded", retries: 0, attempt: 1, cwd: "/tmp", startedAt: now - 5_000, finishedAt: now - 4_000 },
      { id: "fix", agent: "worker", task: "Apply the fix", dependsOn: ["inspect"], status: "running", retries: 0, attempt: 1, cwd: "/tmp", model: "test/model", startedAt: now - 3_000, activity: { turns: 2, toolUses: 3, responseText: "editing fleet view", activeTools: ["read", "replace"], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 } } },
      { id: "review", agent: "reviewer", task: "Review the fix", dependsOn: ["fix", "inspect"], status: "queued", retries: 0, attempt: 0, cwd: "/tmp" },
    ],
  };
}

test("native Mesh tree renders the /subagents-fleet layout and navigation", () => {
  const now = Date.now();
  const meshRun = run(now);
  const oldRun = { ...run(now), id: "old-run", status: "succeeded", updatedAt: now - 30_000, finishedAt: now - 30_000 };
  assert.deepEqual(collectMeshTreeItems([oldRun, meshRun], now).map((item) => item.node.id), ["inspect", "fix", "review"]);

  let closed = false;
  let renders = 0;
  const conversation = Array.from({ length: 30 }, (_, index) => `conversation line ${index}`).join("\n");
  const manager = { list: () => [oldRun, meshRun], conversation: (_runId: string, nodeId: string) => nodeId === "fix" ? conversation : nodeId === "inspect" ? "inspection complete" : "" } as any;
  const component = new MeshTreeComponent({ terminal: { rows: 30 }, requestRender: () => { renders++; } }, theme, undefined, manager, () => { closed = true; }, 60_000);
  try {
    let lines = component.render(100);
    let output = lines.join("\n");
    assert.match(output, /Mesh tree inspector · inspection only · live/);
    assert.match(output, /› └─ ✓ scout/);
    assert.match(output, /node inspect · graph/);
    assert.match(output, /inspection complete/);

    component.handleInput("\u001b[B");
    lines = component.render(100);
    output = lines.join("\n");
    assert.match(output, /›\s+└─ ● worker/);
    assert.match(output, /node fix · graph/);
    assert.match(output, /test\/model · 1\.2k tok · 3 tools · 2 turns/);
    assert.match(output, /conversation line 29/);
    assert.match(output, /read, replace/);

    const followed = output;
    component.handleInput("K");
    output = component.render(100).join("\n");
    assert.notEqual(output, followed);
    assert.ok(renders > 0);

    component.handleInput("\u001b[B");
    output = component.render(100).join("\n");
    assert.match(output, /node review · graph/);
    assert.match(output, /Waiting for: fix/);
    for (const line of lines) assert.ok(visibleWidth(line) <= 100, `line exceeded width: ${line}`);

    component.handleInput("\u001b");
    assert.equal(closed, true);
  } finally {
    component.dispose();
  }
});

test("/mesh-tree opens as a native Pi overlay", async () => {
  let component: MeshTreeComponent | undefined;
  let options: any;
  const manager = { list: () => [run()], conversation: () => "live conversation" } as any;
  const ctx = {
    mode: "tui",
    ui: {
      notify() {},
      custom: async (factory: any, value: any) => {
        options = value;
        component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, () => undefined);
        return undefined;
      },
    },
  } as any;

  await openMeshTree(ctx, manager);
  try {
    assert.ok(component);
    assert.equal(options.overlay, true);
    assert.equal(options.overlayOptions.width, "95%");
    assert.match(component!.render(90).join("\n"), /Mesh tree inspector/);
  } finally {
    component?.dispose();
  }
});
