import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { MeshManager } from "../../src/manager.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");

function agent(name: string): AgentDefinition {
  return { name, description: name, tools: ["read"], systemPrompt: "Do the task", source: "bundled", filePath: `${name}.md` };
}

function queueResponse(queue: string, index: number, response: object): void {
  fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(response));
}

async function withMock<T>(fn: (queue: string) => Promise<T>): Promise<T> {
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-test-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV];
  const oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi;
  process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    return await fn(queue);
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(queue, { recursive: true, force: true });
  }
}

test("runs dependency ordered children and strips recursive extensions", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "first" });
  queueResponse(queue, 2, { output: "second" });
  const manager = new MeshManager((name) => agent(name));
  const run = await manager.start({
    cwd: process.cwd(),
    tasks: [
      { id: "one", agent: "scout", task: "one" },
      { id: "two", agent: "worker", task: "two", dependsOn: ["one"] },
    ],
  });
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.nodes.map((node) => node.output), ["first", "second"]);
  const calls = fs.readdirSync(queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(queue, name), "utf8")));
  assert.equal(calls.length, 2);
  const second = calls.find((call) => call.args.some((value: string) => value.includes("Task: two")));
  assert.ok(second?.args.some((value: string) => value.includes("Direct dependency evidence") && value.includes("first")));
  for (const call of calls) {
    assert.ok(call.args.includes("--no-extensions"));
    assert.ok(call.args.includes("--no-skills"));
    assert.ok(call.args.includes("-e"));
    assert.ok(call.args.some((value: string) => value.endsWith("control-extension.ts")));
    assert.ok(call.args.includes("--tools"));
    assert.ok(call.args.some((value: string) => value.split(",").includes("mesh_control")));
  }
}));

test("rejects dependency cycles before spawning", async () => {
  const manager = new MeshManager((name) => agent(name));
  await assert.rejects(() => manager.start({
    cwd: process.cwd(),
    tasks: [
      { id: "a", agent: "scout", task: "a", dependsOn: ["b"] },
      { id: "b", agent: "scout", task: "b", dependsOn: ["a"] },
    ],
  }), /Dependency cycle/);
});

test("failFast cancels queued dependents after failure", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "bad", stderr: "boom", exitCode: 1 });
  const manager = new MeshManager((name) => agent(name));
  const run = await manager.start({
    cwd: process.cwd(),
    failFast: true,
    tasks: [
      { id: "bad", agent: "worker", task: "bad" },
      { id: "later", agent: "reviewer", task: "later", dependsOn: ["bad"] },
    ],
  });
  assert.equal(run.status, "failed");
  assert.equal(run.nodes[0].status, "failed");
  assert.equal(run.nodes[1].status, "skipped");
  const diagnostic = JSON.parse(fs.readFileSync(run.nodes[0].attemptResultPath!, "utf8"));
  assert.equal(diagnostic.schema, "pi-mesh.attempt-result/v1");
  assert.equal(diagnostic.status, "failed");
  assert.equal(diagnostic.exitCode, 1);
  assert.equal(diagnostic.stderrTail, "boom");
  assert.equal(diagnostic.outputPath, run.nodes[0].outputPath);
}));

test("retryFailed reruns only unsuccessful nodes", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "ok" });
  queueResponse(queue, 2, { output: "bad", stderr: "boom", exitCode: 1 });
  const manager = new MeshManager((name) => agent(name));
  const first = await manager.start({ cwd: process.cwd(), operator: "parallel", tasks: [
    { id: "EPIC-01", agent: "worker", task: "ok" },
    { id: "EPIC-06", agent: "worker", task: "bad" },
  ] });
  assert.equal(first.status, "failed");
  assert.deepEqual(first.nodes.map((node) => [node.id, node.status, node.attempt]), [["EPIC-01", "succeeded", 1], ["EPIC-06", "failed", 1]]);

  queueResponse(queue, 3, { output: "fixed" });
  const retried = await manager.retryFailed(first.id);
  assert.equal(retried.status, "succeeded");
  assert.deepEqual(retried.nodes.map((node) => [node.id, node.status, node.attempt]), [["EPIC-01", "succeeded", 1], ["EPIC-06", "succeeded", 2]]);
  const calls = fs.readdirSync(queue).filter((name) => name.startsWith("call-"));
  assert.equal(calls.length, 3);
}));

test("retryFailed reruns skipped dependents but preserves successful prerequisites", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "base" });
  queueResponse(queue, 2, { output: "bad", stderr: "boom", exitCode: 1 });
  const manager = new MeshManager((name) => agent(name));
  const first = await manager.start({ cwd: process.cwd(), tasks: [
    { id: "base", agent: "worker", task: "base" },
    { id: "bad", agent: "worker", task: "bad", dependsOn: ["base"] },
    { id: "later", agent: "reviewer", task: "later", dependsOn: ["bad"] },
  ] });
  assert.deepEqual(first.nodes.map((node) => node.status), ["succeeded", "failed", "skipped"]);

  queueResponse(queue, 3, { output: "fixed" });
  queueResponse(queue, 4, { output: "done" });
  const retried = await manager.retryFailed(first.id);
  assert.deepEqual(retried.nodes.map((node) => [node.status, node.attempt]), [["succeeded", 1], ["succeeded", 2], ["succeeded", 1]]);
}));
test("session shutdown aborts active children and leaves the run recoverably paused", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "late", delay: 5000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-shutdown-"));
  try {
    const manager = new MeshManager((name) => agent(name));
    const pending = manager.start({ cwd: root, tasks: [{ id: "slow", agent: "worker", task: "slow" }] });
    while (manager.list()[0]?.nodes[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
    const id = manager.list()[0].id;
    await manager.shutdown();
    const run = await pending;
    assert.equal(run.status, "paused");
    assert.equal(run.nodes[0].status, "paused");
    assert.match(run.nodes[0].error ?? "", /session shutdown/);
    assert.equal(fs.existsSync(path.join(root, ".pi", "mesh", "leases", id, "owner.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test("cancels an active run", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "late", delay: 1000 });
  const manager = new MeshManager((name) => agent(name));
  const pending = manager.start({ cwd: process.cwd(), tasks: [{ id: "slow", agent: "worker", task: "slow" }] });
  while (manager.list()[0]?.nodes[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
  const id = manager.list()[0].id;
  assert.equal(manager.cancel(id), true);
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.equal(run.nodes[0].status, "cancelled");
  assert.equal(run.nodes[0].attempt, 1);
}));

test("race succeeds on the first successful node and cancels the rest", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "winner", delay: 20 });
  queueResponse(queue, 2, { output: "late", delay: 5000 });
  const manager = new MeshManager((name) => agent(name));
  const run = await manager.start({ cwd: process.cwd(), operator: "race", tasks: [{ id: "fast", agent: "worker", task: "winner" }, { id: "slow", agent: "worker", task: "late" }] });
  assert.equal(run.status, "succeeded");
  assert.equal(run.nodes.filter((node) => node.status === "succeeded").length, 1);
  assert.equal(run.nodes.filter((node) => node.status === "cancelled").length, 1);
}));

test("late node result cannot overwrite cancellation or start its sibling early", async () => withMock(async (queue) => {
  queueResponse(queue, 1, { output: "late", delay: 200 });
  queueResponse(queue, 2, { output: "next" });
  const manager = new MeshManager((name) => agent(name));
  const pending = manager.start({ cwd: process.cwd(), maxConcurrency: 1, tasks: [
    { id: "slow", agent: "worker", task: "slow" }, { id: "next", agent: "worker", task: "next" },
  ] });
  while (manager.list()[0]?.nodes[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
  const runId = manager.list()[0].id;
  assert.equal(manager.cancel(runId, "slow"), true);
  const run = await pending;
  assert.equal(run.nodes[0].status, "cancelled");
  assert.equal(run.nodes[1].status, "succeeded");
  assert.equal(run.nodes[0].attempt, 1);
}));
