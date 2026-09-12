import assert from "node:assert/strict";
import test from "node:test";
import { inheritedContext, boundedDisplay } from "../../src/runtime-utils.ts";

const entry = (id: string, parentId: string | null, message: any) => ({ type: "message", id, parentId, timestamp: new Date().toISOString(), message } as any);
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const assistant = (content: any[]) => ({ role: "assistant", content, timestamp: 1, api: "test", provider: "test", model: "test", stopReason: "stop" });

test("inherit_context uses SDK compaction summary and never reintroduces compacted messages", () => {
  const branch = [entry("old", null, user("OBSOLETE_HISTORY")), entry("kept", "old", user("KEPT_TASK")),
    { type: "compaction", id: "compact", parentId: "kept", timestamp: new Date().toISOString(), firstKeptEntryId: "kept", summary: "COMPACT_SUMMARY", tokensBefore: 1000 } as any,
    entry("last", "compact", assistant([{ type: "text", text: "LATEST" }]))];
  const text = inheritedContext(branch); assert.match(text, /COMPACT_SUMMARY/); assert.match(text, /KEPT_TASK/); assert.match(text, /LATEST/); assert.doesNotMatch(text, /OBSOLETE_HISTORY/);
});

test("inherit_context trims complete tool interaction groups, drops incomplete groups, and bounds huge arguments", () => {
  const call = assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "INPUT" } }]);
  const tool = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "EVIDENCE" }], timestamp: 1, isError: false };
  const branch = [entry("big", null, user("🙂".repeat(200000))), entry("call", "big", call), entry("result", "call", tool), entry("last", "result", user("LATEST"))];
  const text = inheritedContext(branch); assert.match(text, /truncated/); assert.match(text, /read\(path="INPUT"\)/); assert.match(text, /EVIDENCE/); assert.ok(Buffer.byteLength(text) <= 128 * 1024);
  const incomplete = inheritedContext([entry("call", null, call), entry("last", "call", user("LATEST"))]); assert.doesNotMatch(incomplete, /read\(/); assert.match(incomplete, /LATEST/);
  const huge = inheritedContext([entry("call", null, assistant([{ type: "toolCall", id: "call", name: "write", arguments: { content: "x".repeat(10_000_000) } }])), entry("result", "call", tool)]);
  assert.match(huge, /truncated/); assert.doesNotMatch(huge, /EVIDENCE/);
  assert.ok(boundedDisplay("a\n".repeat(3000)).split("\n").length <= 2000);
});

test("agent discovery diagnostics retain the array API and expose each malformed definition", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const { discoverAgents } = await import("../../src/agents.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-agent-diagnostic-"));
  try {
    const dir = path.join(root, ".pi", "agents"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "missing.md"), "---\nname: missing\n---\nprompt");
    fs.writeFileSync(path.join(dir, "turns.md"), "---\ndescription: bad turns\nmax_turns: nope\n---\nprompt");
    const diagnostics: any[] = []; const agents = discoverAgents(root, { projectRoot: root, onDiagnostic: (item) => diagnostics.push(item) });
    assert.ok(Array.isArray(agents)); assert.ok(agents.some((item) => item.name === "worker")); assert.equal(diagnostics.length, 2);
    assert.match(diagnostics.map((item) => item.message).join("\n"), /Missing description[\s\S]*Invalid max_turns/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
