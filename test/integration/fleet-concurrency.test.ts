import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { FleetLimiter } from "../../src/fleet-limiter.ts";
import { MeshManager } from "../../src/manager.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";
import { SessionAgentManager } from "../../src/session-agents.ts";
import { defaultMeshSettings } from "../../src/settings.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", source: "bundled", filePath: path.resolve("agents/worker.md") };

test("direct agents and mesh nodes share one session fleet cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-shared-fleet-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-shared-fleet-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "direct", delay: 150 }));
    fs.writeFileSync(path.join(queue, "pending-002.json"), JSON.stringify({ output: "mesh" }));
    const settings = { ...defaultMeshSettings, maxConcurrentAgents: 1 };
    const limiter = new FleetLimiter(1);
    const direct = new SessionAgentManager(settings, root, undefined, "session", limiter);
    const mesh = new MeshManager(() => agent, settings, limiter);
    const record = direct.spawn(agent, "direct", "direct", root, {});
    const pending = mesh.start({ cwd: root, tasks: [{ id: "node", agent: "worker", task: "mesh" }] });
    for (let i = 0; i < 100 && fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length, 1);
    assert.equal(mesh.list()[0]?.nodes[0]?.status, "running");
    await record.promise;
    const run = await pending;
    assert.equal(run.nodes[0]?.status, "succeeded");
    assert.equal(fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length, 2);
    await direct.shutdown(); await mesh.shutdown();
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true });
  }
});
