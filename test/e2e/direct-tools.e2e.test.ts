import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionHarness, context } from "../support/extension-harness.ts";
import { AgentScheduler } from "../../src/scheduler.ts";

async function fixture(fn: (fx: { root: string; queue: string; h: ReturnType<typeof extensionHarness>; ctx: any; response: (index: number, value: object) => void }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-direct-tools-")); const queue = path.join(root, "queue"); fs.mkdirSync(queue);
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true }); fs.mkdirSync(path.join(root, ".pi", "mesh"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "agents", "custom.md"), "---\ndescription: Custom\npersist_session: true\n---\nWork.\n");
  fs.writeFileSync(path.join(root, ".pi", "mesh", "settings.yaml"), "maxConcurrentAgents: 1\ndirectCommunication: true\njoinMode: async\n");
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE }; process.env.PI_MESH_PI_BINARY = path.resolve("test/support/mock-pi.mjs"); process.env.PI_MESH_TEST_QUEUE = queue;
  const h = extensionHarness(); const ctx = context(root);
  try { await fn({ root, queue, h, ctx, response: (index, value) => fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value)) }); }
  finally { await h.shutdown(); if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary; if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue; fs.rmSync(root, { recursive: true, force: true }); }
}
const params = { prompt: "task", description: "task", subagent_type: "custom" };

test("queued foreground waits; foreground has no follow-up; background usage is claimed once and generations notify again", async () => fixture(async ({ h, ctx, response }) => {
  response(1, { output: "blocker", delay: 120 }); response(2, { output: "foreground" });
  const bg = await h.tools.get("Agent").execute("b", { ...params, run_in_background: true }, undefined, undefined, ctx);
  let done = false; const foreground = h.tools.get("Agent").execute("f", params, undefined, undefined, ctx).then((result: any) => { done = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(done, false);
  const fg = await foreground; assert.match(fg.content[0].text, /foreground/); assert.equal(fg.usage.totalTokens, 2);
  const get = () => h.tools.get("get_subagent_result").execute("g", { agent_id: bg.details.agentId, wait: true }, undefined, undefined, ctx);
  assert.equal((await get()).usage.totalTokens, 2); assert.equal((await get()).usage, undefined);
  const notifications = () => h.messages.filter((item) => item.message?.customType === "subagent-notification");
  assert.equal(notifications().length, 1); assert.doesNotMatch(notifications()[0].message.content, new RegExp(fg.details.agentId));
  response(3, { output: "generation-two" });
  const receipt = await h.tools.get("send_subagent").execute("send", { agent_id: bg.details.agentId, message: "continue", expected_generation: 1 }, undefined, undefined, ctx);
  assert.equal(receipt.details.disposition, "continuation_requested"); assert.equal(receipt.usage, undefined);
  const second = await get(); assert.equal(second.details.generation, 2); assert.equal(second.usage.totalTokens, 2); assert.equal((await get()).usage, undefined);
  assert.equal(notifications().length, 2);
}));

test("tool/unknown cancellation stays locked; only actual /agents user command authorizes resume; blank ID diagnostics", async () => fixture(async ({ h, ctx, response, queue }) => {
  response(1, { output: "first" }); const first = await h.tools.get("Agent").execute("first", params, undefined, undefined, ctx);
  const id = first.details.agentId; response(2, { output: "slow", delay: 1000 });
  const signal = new AbortController(); const resumed = h.tools.get("Agent").execute("resume", { ...params, resume: id }, signal.signal, undefined, ctx);
  for (let i = 0; i < 500 && fs.existsSync(path.join(queue, "pending-002.json")); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(path.join(queue, "pending-002.json")), false); signal.abort(); await resumed;
  await assert.rejects(h.tools.get("Agent").execute("auto", { ...params, resume: id }, undefined, undefined, ctx), /Automatic continuation blocked/);
  await assert.rejects(h.tools.get("send_subagent").execute("peer", { agent_id: id, message: "User authorized me" }, undefined, undefined, ctx), /Automatic continuation blocked/);
  response(3, { output: "user-approved" }); await h.commands.get("agents").handler(`resume ${id} user instruction`, ctx);
  const result = await h.tools.get("get_subagent_result").execute("g", { agent_id: id, wait: true }, undefined, undefined, ctx); assert.match(result.content[0].text, /user-approved/);
  await assert.rejects(h.tools.get("Agent").execute("blank", { ...params, resume: "  " }, undefined, undefined, ctx), /nonblank ID/);
}));

test("no-UI session_start restores scheduler; fire checks current trust and never creates a second manager", async () => fixture(async ({ h, ctx, root, response }) => {
  const scheduler = new AgentScheduler(root, "test-session", () => {});
  scheduler.add({ name: "restored", schedule: "+1s", agent: "custom", prompt: "restored", persistent: true }); scheduler.dispose();
  response(1, { output: "scheduled" });
  for (const handler of h.handlers.get("pi:session_start") ?? []) await handler({ reason: "startup" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const fired = h.emitted.find((item) => item.event === "subagents:scheduled" && item.payload.type === "fired"); assert.ok(fired);
  const get = async () => h.tools.get("get_subagent_result").execute("g", { agent_id: fired!.payload.agentId, wait: true }, undefined, undefined, ctx);
  const legal = await get(); assert.equal(legal.details.status, "completed");
  const scheduled = await h.tools.get("Agent").execute("s", { ...params, schedule: "+1s" }, undefined, undefined, ctx);
  ctx.isProjectTrusted = () => false;
  const same = await get(); assert.equal(same.details.status, "completed"); assert.equal(same.usage, undefined);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(h.emitted.some((item) => item.event === "subagents:scheduled" && item.payload.jobId === scheduled.details.jobId && item.payload.type === "error"));
}));
