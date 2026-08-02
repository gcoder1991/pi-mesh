import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerPiMesh from "../../src/extension.ts";

test("registers one mesh tool with strict actions", () => {
  let tool: any;
  const tools: any[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(value: any) { tools.push(value); if (value.name === "mesh") tool = value; },
    getAllTools() { return tools; },
    events: { emit() {}, on() { return () => {}; } }, sendMessage() {}, registerCommand() {}, registerShortcut() {},
    on(name: string) { events.push(name); },
  };
  registerPiMesh(pi as any);
  assert.equal(tool.name, "mesh");
  assert.deepEqual(tools.map((item) => item.name), ["mesh", "Agent", "get_subagent_result", "steer_subagent"]);
  assert.match(tool.promptSnippet, /specialized sub-agents/);
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("action list_agents")));
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("routing contract")));
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("Do not duplicate work")));
  assert.deepEqual(tool.parameters.properties.action.enum, ["list_agents", "run", "status", "list", "cancel", "pause", "resume", "recover", "steer", "handoff_list", "message_send", "message_broadcast", "message_inbox", "message_ack", "growth_list", "growth_decide"]);
  assert.ok(events.includes("session_shutdown"));
});

test("ignores project agents until Pi trusts the project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-trust-"));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "agents", "project-only.md"), "---\nname: project-only\ndescription: project only\n---\nPrompt\n");
  let tool: any;
  try {
    const tools: any[] = [];
    registerPiMesh({ registerTool(value: any) { tools.push(value); if (value.name === "mesh") tool = value; }, getAllTools() { return tools; }, events: { emit() {}, on() { return () => {}; } }, sendMessage() {}, registerCommand() {}, registerShortcut() {}, on() {} } as any);
    const execute = (trusted: boolean) => tool.execute("test", { action: "list_agents" }, undefined, undefined, { cwd: root, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "test-session" } } as any);
    const untrusted = await execute(false);
    assert.equal(untrusted.details.agents.some((agent: any) => agent.name === "project-only"), false);
    const trusted = await execute(true);
    assert.equal(trusted.details.agents.some((agent: any) => agent.name === "project-only"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("does not register inside mesh children", () => {
  const old = process.env.PI_MESH_CHILD;
  process.env.PI_MESH_CHILD = "1";
  let registered = false;
  try {
    registerPiMesh({ registerTool() { registered = true; }, getAllTools() { return []; } } as any);
    assert.equal(registered, false);
  } finally {
    if (old === undefined) delete process.env.PI_MESH_CHILD; else process.env.PI_MESH_CHILD = old;
  }
});
