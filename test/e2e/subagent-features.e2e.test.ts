import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionHarness, context } from "../support/extension-harness.ts";
import { mockPi } from "../support/e2e.ts";

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-features-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-features-q-")); const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE }; process.env.PI_MESH_PI_BINARY = mockPi; process.env.PI_MESH_TEST_QUEUE = queue; return { root, queue, cleanup() { if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary; if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); } }; }
function response(queue: string, index: number, value: object) { fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value)); }

test("Agent passes thinking, parent context, memory, tool denylist, and prompt mode to Pi", async () => {
  const fx = fixture(); const harness = extensionHarness();
  try {
    const dir = path.join(fx.root, ".pi", "agents"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "configured.md"), "---\ndescription: Configured\ntools: read, bash\ndisallowed_tools: bash\nthinking: high\nprompt_mode: replace\ninherit_context: true\nmemory: project\n---\nConfigured prompt.\n");
    const memory = path.join(fx.root, ".pi", "agent-memory", "configured"); fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(path.join(memory, "MEMORY.md"), "memory fact");
    response(fx.queue, 1, { output: "done" });
    const hostModel = { provider: "cpa", id: "host-model", name: "Host Model" };
    await harness.tools.get("Agent").execute("x", { prompt: "do", description: "do", subagent_type: "configured" }, undefined, undefined, context(fx.root, { branch: [{ type: "message", message: { role: "user", content: "parent fact" } }], model: hostModel, modelRegistry: { getAvailable: () => [hostModel] } }));
    const call = JSON.parse(fs.readFileSync(path.join(fx.queue, fs.readdirSync(fx.queue).find((name) => name.startsWith("call-"))!), "utf8"));
    assert.ok(call.args.includes("--model")); assert.ok(call.args.includes("cpa/host-model")); assert.ok(call.args.includes("--thinking")); assert.ok(call.args.includes("high")); assert.ok(call.args.includes("--exclude-tools")); assert.ok(call.args.includes("bash")); assert.ok(call.args.includes("--system-prompt")); assert.ok(call.args.includes("--no-context-files"));
    const task = call.args.at(-1); assert.match(task, /parent fact/); assert.match(task, /memory fact/);
  } finally { await harness.shutdown(); fx.cleanup(); }
});

test("Agent scheduling preserves launch options and emits lifecycle events", async () => {
  const fx = fixture(); const harness = extensionHarness();
  try {
    const dir = path.join(fx.root, ".pi", "agents"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scheduled.md"), "---\ndescription: Scheduled\ntools: read\nthinking: high\nmax_turns: 7\npersist_session: true\n---\nScheduled prompt.\n");
    response(fx.queue, 1, { output: "scheduled" });
    const scheduled = await harness.tools.get("Agent").execute("x", { prompt: "scheduled", description: "scheduled", subagent_type: "scheduled", model: "mock/model", schedule: "+1s" }, undefined, undefined, context(fx.root, { modelRegistry: { getAvailable: () => [{ provider: "mock", id: "model" }] } }));
    assert.equal(scheduled.details.status, "scheduled");
    for (let i = 0; i < 100 && !fs.readdirSync(fx.queue).some((name) => name.startsWith("call-")); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(harness.emitted.some((item) => item.event === "subagents:scheduled" && item.payload.type === "fired"));
    const callFile = fs.readdirSync(fx.queue).find((name) => name.startsWith("call-"));
    assert.ok(callFile);
    const call = JSON.parse(fs.readFileSync(path.join(fx.queue, callFile), "utf8"));
    assert.ok(call.args.includes("--model")); assert.ok(call.args.includes("mock/model")); assert.ok(call.args.includes("--thinking")); assert.ok(call.args.includes("high")); assert.ok(call.args.includes("--session-id"));
  } finally { await harness.shutdown(); fx.cleanup(); }
});
