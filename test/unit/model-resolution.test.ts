import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentModel } from "../../src/model-resolution.ts";

const registry = { getAvailable: () => [
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  { provider: "openai", id: "gpt-5-5", name: "GPT 5.5" },
] } as any;

test("resolves exact, fuzzy, dated, and cross-provider model names", () => {
  assert.equal(resolveAgentModel("anthropic/claude-haiku-4-5-20251001", registry), "anthropic/claude-haiku-4-5-20251001");
  assert.equal(resolveAgentModel("haiku", registry), "anthropic/claude-haiku-4-5-20251001");
  assert.equal(resolveAgentModel("anthropic/claude-haiku-4.5", registry), "anthropic/claude-haiku-4-5-20251001");
  assert.equal(resolveAgentModel("gpt-5.5", registry), "openai/gpt-5-5");
  assert.throws(() => resolveAgentModel("missing", registry), /unavailable or ambiguous/);
});
