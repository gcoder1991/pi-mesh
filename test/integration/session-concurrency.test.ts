import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { SessionAgentManager } from "../../src/session-agents.ts";
import { defaultMeshSettings } from "../../src/settings.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };

test("background Agent launches obey the configured concurrency queue", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-session-concurrency-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-session-concurrency-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE; process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "one", delay: 100 })); fs.writeFileSync(path.join(queue, "pending-002.json"), JSON.stringify({ output: "two" }));
    const manager = new SessionAgentManager({ ...defaultMeshSettings, maxConcurrentAgents: 1 }, root);
    const first = manager.spawn(agent, "one", "one", root, {}); const second = manager.spawn(agent, "two", "two", root, {});
    assert.equal(first.status, "running"); assert.equal(second.status, "queued");
    await first.promise; while (manager.get(second.id)?.status !== "completed") await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(second.result?.output, "two"); await manager.shutdown();
  } finally { if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary; if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); }
});

test("stopping a running Agent is terminal even after the child settles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-session-stop-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-session-stop-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE; process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "late", delay: 5000 }));
    const completed: string[] = []; const manager = new SessionAgentManager(defaultMeshSettings, root, (record) => completed.push(record.status));
    const record = manager.spawn(agent, "slow", "slow", root, {});
    assert.equal(manager.abort(record.id), true);
    await record.promise;
    assert.equal(record.status, "stopped");
    assert.deepEqual(completed, ["stopped"]);
    await manager.shutdown();
  } finally { if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary; if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); }
});
