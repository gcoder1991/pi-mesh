import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildConsensusPrompt, compactConsensusModels } from "../../src/consensus-template.ts";
import { context, extensionHarness } from "../support/extension-harness.ts";

const models = [
  { provider: "zeta", id: "writer", name: "Writer", reasoning: true, contextWindow: 200_000, cost: { input: 2, output: 8 } },
  { provider: "alpha", id: "reviewer", name: "Reviewer", reasoning: true, contextWindow: 100_000, cost: { input: 1, output: 4 } },
  { provider: "beta", id: "finalizer", name: "Finalizer", reasoning: true, contextWindow: 150_000, cost: { input: 3, output: 9 } },
];

test("builds the bounded two-round consensus protocol", () => {
  assert.deepEqual(compactConsensusModels([...models, models[0]], "zeta/writer").map((model) => model.id), ["zeta/writer", "alpha/reviewer", "beta/finalizer"]);

  const prompt = buildConsensusPrompt({ task: "Implement the change", models, hostModel: "zeta/writer", questionToolAvailable: true });
  assert.match(prompt, /ask_user_question exactly once with three questions/);
  assert.match(prompt, /operator="graph", worktree=true, failFast=true/);
  assert.match(prompt, /implement-X: no dependencies/);
  assert.match(prompt, /critique-1-X: depends on every implement-\* node/);
  assert.match(prompt, /revise-1-X: depends on implement-X and ledger-1/);
  assert.match(prompt, /critique-2-X: depends on every revise-1-\* node/);
  assert.match(prompt, /consensus-final: depends on ledger-2 and every revise-2-\* node/);
  assert.match(prompt, /CONSENSUS_BY_MAJORITY/);
  assert.match(prompt, /FINALIZER_TIEBREAK/);
  assert.match(prompt, /Implement the change$/);
});

test("fails closed without three distinct available models", () => {
  assert.throws(() => buildConsensusPrompt({ task: "x", models: [models[0], models[0]], questionToolAvailable: true }), /at least 3 available models/);
  assert.throws(() => buildConsensusPrompt({ task: " ", models, questionToolAvailable: true }), /Usage: \/consensus/);
});

test("uses a plain-question fallback when ask_user_question is unavailable", () => {
  const prompt = buildConsensusPrompt({ task: "x", models, questionToolAvailable: false });
  assert.match(prompt, /ask_user_question tool is unavailable/);
  assert.match(prompt, /then stop and wait/);
  assert.doesNotMatch(prompt, /Call ask_user_question exactly once/);
});

test("registers /consensus and injects the Host catalog into the next turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-consensus-"));
  const harness = extensionHarness();
  const notifications: Array<{ message: string; level: string }> = [];
  try {
    harness.pi.registerTool({ name: "ask_user_question" });
    const ctx = context(root, {
      model: models[0],
      modelRegistry: { getAvailable: () => models },
      ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
    });
    ctx.isIdle = () => true;

    await harness.commands.get("consensus").handler("Implement safely", ctx);
    const prompt = harness.messages.at(-1)?.userMessage;
    assert.match(prompt, /Valid provider\/model IDs: \["zeta\/writer","alpha\/reviewer","beta\/finalizer"\]/);
    assert.match(prompt, /Call ask_user_question exactly once/);
    assert.match(prompt, /Implement safely$/);
    assert.deepEqual(notifications, []);
  } finally {
    await harness.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
