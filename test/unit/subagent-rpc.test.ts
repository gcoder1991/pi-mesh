import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionHarness, context } from "../support/extension-harness.ts";
import { mockPi } from "../support/e2e.ts";

test("cross-extension RPC exposes ping, spawn, and stop envelopes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-rpc-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-rpc-q-"));
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE }; process.env.PI_MESH_PI_BINARY = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  const harness = extensionHarness(); const ctx = context(root);
  try {
    let ping: any; harness.pi.events.on("subagents:rpc:ping:reply:p", (value: any) => { ping = value; }); harness.pi.events.emit("subagents:rpc:ping", { requestId: "p" }); assert.equal(ping.success, true);
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "rpc", delay: 500 }));
    let spawn: any; harness.pi.events.on("subagents:rpc:spawn:reply:s", (value: any) => { spawn = value; }); harness.pi.events.emit("subagents:rpc:spawn", { requestId: "s", type: "worker", prompt: "rpc", options: { description: "rpc" }, ctx }); assert.equal(spawn.success, true);
    let stop: any; harness.pi.events.on("subagents:rpc:stop:reply:x", (value: any) => { stop = value; }); harness.pi.events.emit("subagents:rpc:stop", { requestId: "x", agentId: spawn.data.id, ctx }); assert.equal(stop.success, true);
  } finally { await harness.shutdown(); if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary; if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); }
});
