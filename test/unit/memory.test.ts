import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { memoryPrompt } from "../../src/memory.ts";

function agent(tools: string[]): AgentDefinition { return { name: "memo", description: "memo", tools, memory: "project", systemPrompt: "", source: "project", filePath: "memo.md" }; }
test("memory is bounded and follows agent write authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-memory-"));
  try {
    const dir = path.join(root, ".pi", "agent-memory", "memo"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "MEMORY.md"), "remember me");
    assert.match(memoryPrompt(agent(["read"]), root), /read-only[\s\S]*remember me/);
    assert.match(memoryPrompt(agent(["read", "write"]), root), /may update[\s\S]*remember me/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
