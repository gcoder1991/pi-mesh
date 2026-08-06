import assert from "node:assert/strict";
import test from "node:test";
import { appendUtf8Tail, trackActivity, truncateUtf8 } from "../../src/runtime-utils.ts";

test("UTF-8 byte limits never split a character", () => {
  const text = "ab😀cd";
  assert.equal(truncateUtf8(text, 5), "ab");
  assert.equal(truncateUtf8(text, 5, "tail"), "cd");
  assert.equal(appendUtf8Tail(Buffer.from("ab😀"), Buffer.from("cd"), 5).toString("utf8"), "cd");
});

test("shared activity tracking accumulates tools, text, and usage", () => {
  const target: { activity?: import("../../src/runtime-utils.ts").AgentActivity } = {};
  trackActivity(target, { type: "turn_start" });
  trackActivity(target, { type: "tool_execution_start", toolName: "read" });
  trackActivity(target, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "checking assumptions" } });
  trackActivity(target, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
  trackActivity(target, { type: "message_end", message: { role: "assistant", usage: { input: 2, output: 3, cost: { total: 0.5 } } } });
  trackActivity(target, { type: "tool_execution_end", toolName: "read" });
  assert.deepEqual(target.activity, { turns: 1, toolUses: 1, responseText: "working", thinkingText: "checking assumptions", activeTools: [], usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, turns: 1 } });
});
