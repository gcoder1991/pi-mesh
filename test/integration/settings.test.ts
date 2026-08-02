import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { MeshManager } from "../../src/manager.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent = (name: string): AgentDefinition => ({ name, description: name, tools: ["read"], systemPrompt: "work", source: "bundled", filePath: `${name}.md` });

test("settings cap concurrency/depth and debug writes diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-settings-int-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-settings-queue-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    const settings = { maxAgentDepth: 2, maxConcurrentAgents: 1, maxNodes: 4, messagePayloadMaxBytes: 32768, recipientUnreadMaxBytes: 1048576, childExtensions: {}, childSkills: {}, joinMode: "smart" as const, debug: true };
    const manager = new MeshManager((name) => agent(name), settings);
    await assert.rejects(() => manager.start({ cwd: root, maxConcurrency: 2, tasks: [{ agent: "worker", task: "x" }] }), /maxConcurrency must be 1-1/);
    await assert.rejects(() => manager.start({ cwd: root, tasks: [{ agent: "worker", task: "x", cwd: path.join(root, "..", "outside") }] }), /ENOENT|Task cwd must remain inside the run root/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-outside-"));
    const link = path.join(root, "outside-link"); fs.symlinkSync(outside, link);
    await assert.rejects(() => manager.start({ cwd: root, tasks: [{ agent: "worker", task: "x", cwd: link }] }), /Task cwd must remain inside the run root/);
    fs.rmSync(outside, { recursive: true, force: true });
    await assert.rejects(() => manager.start({ cwd: root, tasks: [
      { id: "a", agent: "worker", task: "a" }, { id: "b", agent: "worker", task: "b", dependsOn: ["a"] }, { id: "c", agent: "worker", task: "c", dependsOn: ["b"] },
    ] }), /depth 3 exceeds maxAgentDepth 2/);
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "bad", stderr: "failure details", exitCode: 1 }));
    const run = await manager.start({ cwd: root, tasks: [{ id: "bad", agent: "worker", task: "bad" }] });
    const node = run.nodes[0];
    assert.match(fs.readFileSync(node.diagnosticPath!, "utf8"), /child process exited with code 1[\s\S]*failure details/);
    const events = fs.readFileSync(path.join(root, ".pi", "mesh", "debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), ["run_started", "attempt_finished"]);
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true });
  }
});
