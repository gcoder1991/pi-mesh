import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionHarness, context } from "../support/extension-harness.ts";
import { mockPi } from "../support/e2e.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-e2e-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-e2e-q-"));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "agents", "custom.md"), "---\ndescription: Custom agent\ntools: read\npersist_session: true\n---\nDo the task.\n");
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  process.env.PI_MESH_PI_BINARY = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  return { root, queue, cleanup() { if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary; if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); } };
}
function respond(queue: string, index: number, value: object) { fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value)); }

test("Agent foreground, background, wait, steer, resume, notifications, and events share one runtime", async () => {
  const fx = fixture(); const harness = extensionHarness(); const ctx = context(fx.root);
  try {
    respond(fx.queue, 1, { output: "foreground" });
    const foreground = await harness.tools.get("Agent").execute("a1", { prompt: "foreground", description: "foreground", subagent_type: "custom" }, undefined, undefined, ctx);
    assert.match(foreground.content[0].text, /foreground/); assert.equal(foreground.usage.totalTokens, 2);

    respond(fx.queue, 2, { output: "background", delay: 80 });
    const background = await harness.tools.get("Agent").execute("a2", { prompt: "background", description: "background", subagent_type: "custom", run_in_background: true }, undefined, undefined, ctx);
    const id = background.details.agentId; assert.ok(id);
    await harness.tools.get("steer_subagent").execute("s", { agent_id: id, message: "focus" }, undefined, undefined, ctx);
    const waited = await harness.tools.get("get_subagent_result").execute("g", { agent_id: id, wait: true, verbose: true }, undefined, undefined, ctx);
    assert.match(waited.content[0].text, /background[\s\S]*Agent Conversation/);
    assert.ok(harness.messages.some((item) => item.message.customType === "subagent-notification"));
    assert.ok(harness.emitted.some((item) => item.event === "subagents:created")); assert.ok(harness.emitted.some((item) => item.event === "subagents:steered")); assert.ok(harness.emitted.some((item) => item.event === "subagents:completed"));

    respond(fx.queue, 3, { output: "resumed" });
    const resumed = await harness.tools.get("Agent").execute("r", { prompt: "resume", description: "resume", subagent_type: "custom", resume: id }, undefined, undefined, ctx);
    assert.match(resumed.content[0].text, /resumed/);
  } finally { await harness.shutdown(); fx.cleanup(); }
});

test("Agent enforces project trust and explicit extension/skill allowlists", async () => {
  const fx = fixture();
  try {
    fs.writeFileSync(path.join(fx.root, ".pi", "agents", "resource.md"), "---\ndescription: Resources\nextensions: mcp\nskills: browser\n---\nUse resources.\n");
    const harness = extensionHarness();
    await assert.rejects(() => harness.tools.get("Agent").execute("u", { prompt: "x", description: "x", subagent_type: "resource" }, undefined, undefined, context(fx.root, { trusted: false })), /Unknown agent type/);
    await assert.rejects(() => harness.tools.get("Agent").execute("t", { prompt: "x", description: "x", subagent_type: "resource" }, undefined, undefined, context(fx.root)), /Unapproved child resources/);
    await harness.shutdown();
  } finally { fx.cleanup(); }
});
