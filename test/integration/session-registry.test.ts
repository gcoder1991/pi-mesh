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
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", persistSession: true, source: "bundled", filePath: path.resolve("agents/worker.md") };

test("session agent registry survives manager recreation and resumes the same Pi session id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "first" }));
    const firstManager = new SessionAgentManager(defaultMeshSettings, root, undefined, "session-a");
    const first = firstManager.spawn(agent, "first", "first", root, { persistent: true }); await first.promise; const id = first.id;
    assert.equal(first.execution, undefined);
    const isolatedManager = new SessionAgentManager(defaultMeshSettings, root, undefined, "session-b");
    assert.equal(isolatedManager.get(id), undefined);
    await isolatedManager.shutdown();
    const secondManager = new SessionAgentManager(defaultMeshSettings, root, undefined, "session-a");
    assert.equal(secondManager.get(id)?.status, "completed");
    assert.equal(secondManager.get(id)?.execution, undefined);
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

test("session registry keeps a bounded preview and full output artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-output-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-output-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE; process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    const output = "x".repeat(300 * 1024); fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output }));
    const manager = new SessionAgentManager(defaultMeshSettings, root, undefined, "large-output");
    const record = manager.spawn({ ...agent, persistSession: false }, "large", "large", root, {}); await record.promise;
    assert.equal(record.outputBytes, 300 * 1024); assert.equal(record.outputTruncated, true);
    assert.ok(record.outputPath && fs.readFileSync(record.outputPath, "utf8") === output);
    assert.ok(Buffer.byteLength(record.result?.output ?? "") < 210 * 1024);
    await manager.shutdown();
  } finally { if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary; if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); }
});

test("non-persistent agents are not reconnected after manager recreation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-ephemeral-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-ephemeral-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE; process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "done" }));
    const ephemeral = { ...agent, persistSession: false };
    const firstManager = new SessionAgentManager(defaultMeshSettings, root, undefined, "ephemeral");
    const record = firstManager.spawn(ephemeral, "done", "done", root, { persistent: false }); await record.promise; await firstManager.shutdown();
    const callsBefore = fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length;
    const restored = new SessionAgentManager(defaultMeshSettings, root, undefined, "ephemeral");
    assert.equal(restored.get(record.id)?.execution, undefined);
    assert.equal(fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length, callsBefore);
    await assert.rejects(() => restored.resume(record.id, "again"), /was not persisted/);
    await restored.shutdown();
  } finally { if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary; if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); }
});
test("session agent registry fails closed on corruption and foreign project records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-registry-invalid-"));
  const dir = path.join(root, ".pi", "mesh", "subagents"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "f1234d75178d892a.json");
  try {
    fs.writeFileSync(file, "not-json"); assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /Invalid JSON state/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: root, status: "completed", agent: { name: "worker" }, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /malformed agent/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: root, status: "completed", agent: { ...agent, extensions: ["../escape"] }, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /unsafe agent resources/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: root, status: "completed", agent: { ...agent, extensions: ["unapproved"] }, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /unsafe agent resources/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: root, status: "completed", agent: { ...agent, filePath: path.join(root, "outside.md") }, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /invalid agent file|escapes source root/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: root, status: "completed", agent, launch: { transcriptPath: path.join(os.tmpdir(), "escape.jsonl") }, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /unsafe transcript path/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: root, status: "completed", agent, launch: { sessionDir: os.tmpdir() }, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /unsafe session directory/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", cwd: os.tmpdir(), status: "completed", agent, prompt: "x", description: "x", createdAt: 1 }]));
    assert.throws(() => new SessionAgentManager(defaultMeshSettings, root, undefined, "invalid"), /escapes project root/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
