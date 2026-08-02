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
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", persistSession: true, source: "bundled", filePath: "worker.md" };

test("session agent registry survives manager recreation and resumes the same Pi session id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "first" }));
    const firstManager = new SessionAgentManager(defaultMeshSettings, root);
    const first = firstManager.spawn(agent, "first", "first", root, { persistent: true }); await first.promise; const id = first.id; await first.execution?.close();
    const secondManager = new SessionAgentManager(defaultMeshSettings, root);
    assert.equal(secondManager.get(id)?.status, "completed");
    fs.writeFileSync(path.join(queue, "pending-002.json"), JSON.stringify({ output: "second" }));
    const resumed = await secondManager.resume(id, "second"); assert.equal(resumed.result?.output, "second");
    const calls = fs.readdirSync(queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(queue, name), "utf8")));
    assert.ok(calls.every((call) => call.args.includes(id)));
    await secondManager.shutdown();
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true });
  }
});

test("session agent registry fails closed on corruption and foreign project records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-invalid-"));
  const file = path.join(root, ".pi", "mesh", "subagents.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, "not-json"); assert.throws(() => new SessionAgentManager(defaultMeshSettings, root), /Invalid JSON state/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: os.tmpdir(), status: "completed", agent, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root), /escapes project root/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
