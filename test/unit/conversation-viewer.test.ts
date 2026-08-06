import assert from "node:assert/strict";
import test from "node:test";
import { ConversationViewer } from "../../src/conversation-viewer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const record = () => ({ id: "a", agent: "worker", description: "work", status: "running", createdAt: Date.now() - 1000, turns: 2, toolUses: 1, tokens: 1200, conversation: () => "one\ntwo\nthree", activeTools: ["read"] });

test("conversation viewer shows thinking beside active tools", () => {
  const current = { ...record(), thinkingText: "checking assumptions", responseText: "drafting answer" };
  const viewer = new ConversationViewer({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, () => current, () => {}, () => {}, () => {});
  assert.match(viewer.render(100).join("\n"), /tool: read · thinking: checking assumptions/);
  viewer.dispose();
});

test("conversation viewer uses two-key stop confirmation", () => {
  let stops = 0; const current = record();
  const viewer = new ConversationViewer({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, () => current, () => {}, () => { stops++; }, () => {});
  viewer.handleInput("x"); assert.equal(stops, 0); assert.match(viewer.render(80).join("\n"), /again to STOP/);
  viewer.handleInput("x"); assert.equal(stops, 1); viewer.dispose();
});

test("conversation viewer disarms stop when the record becomes terminal", () => {
  let stops = 0; const current = record();
  const viewer = new ConversationViewer({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, () => current, () => {}, () => { stops++; }, () => {});
  viewer.handleInput("x");
  current.status = "completed"; viewer.handleInput("j");
  current.status = "running"; viewer.handleInput("x");
  assert.equal(stops, 0);
  viewer.handleInput("x"); assert.equal(stops, 1); viewer.dispose();
});
test("conversation viewer sends steer through inline composer", () => {
  let message = ""; const current = record();
  const viewer = new ConversationViewer({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, () => current, () => {}, () => {}, (value) => { message = value; });
  viewer.handleInput("\r");
  for (const char of "focus") viewer.handleInput(char);
  viewer.handleInput("\r");
  assert.equal(message, "focus"); viewer.dispose();
});

test("conversation viewer honors custom scroll bindings", () => {
  let matched = 0; const current = { ...record(), conversation: () => Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") };
  const bindings = { matches(data: string, id: string) { if (data === "ctrl+p" && id === "tui.select.up") { matched++; return true; } return false; } } as any;
  const viewer = new ConversationViewer({ terminal: { rows: 20 }, requestRender() {} }, theme, bindings, () => current, () => {}, () => {}, () => {});
  viewer.render(80); viewer.handleInput("ctrl+p");
  assert.equal(matched, 1); viewer.dispose();
});
