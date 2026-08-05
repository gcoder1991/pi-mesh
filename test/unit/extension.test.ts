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
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const pi = {
    registerTool(value: any) { tools.push(value); if (value.name === "mesh") tool = value; },
    getAllTools() { return tools; },
    events: { emit() {}, on() { return () => {}; } }, sendMessage() {}, sendUserMessage() {},
    registerCommand(name: string) { commands.push(name); }, registerShortcut(name: string) { shortcuts.push(name); },
    on(name: string) { events.push(name); },
  };
  registerPiMesh(pi as any);
  assert.equal(tool.name, "mesh");
  assert.deepEqual(tools.map((item) => item.name), ["mesh", "Agent", "get_subagent_result", "steer_subagent"]);
  assert.match(tool.promptSnippet, /specialized sub-agents/);
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("action list_agents")));
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("routing contract")));
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("absolute definition path")));
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("Do not duplicate work")));
  assert.ok(tool.promptGuidelines.some((guideline: string) => guideline.includes("retry_failed")));
  assert.deepEqual(tool.parameters.properties.action.enum, ["list_agents", "run", "status", "list", "cancel", "pause", "resume", "retry_failed", "recover", "steer", "handoff_list", "message_send", "message_broadcast", "message_inbox", "message_ack", "growth_list", "growth_decide"]);
  assert.ok(events.includes("session_shutdown"));
  assert.ok(commands.includes("mesh-tree"));
  assert.ok(shortcuts.includes("ctrl+shift+m"));
});

test("resolves mesh task model overrides through the host registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-model-")); let tool: any;
  try {
    fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pi", "agents", "pinned.md"), "---\nname: pinned\ndescription: pinned\nmodel: anthropic/pinned-model\n---\nPinned\n");
    const tools: any[] = [];
    registerPiMesh({ registerTool(value: any) { tools.push(value); if (value.name === "mesh") tool = value; }, getAllTools() { return tools; }, events: { emit() {}, on() { return () => {}; } }, sendMessage() {}, sendUserMessage() {}, registerCommand() {}, registerShortcut() {}, on() {} } as any);
    const available = [{ provider: "openai", id: "gpt-test", name: "GPT Test" }, { provider: "cpa", id: "host-model", name: "Host Model" }, { provider: "anthropic", id: "pinned-model", name: "Pinned Model" }];
    const ctx = { cwd: root, mode: "print", isProjectTrusted: () => true, sessionManager: { getSessionId: () => "model-session" }, model: available[1], modelRegistry: { getAvailable: () => available } };
    const started = await tool.execute("test", { action: "run", async: true, tasks: [{ id: "a", agent: "worker", task: "x", model: "gpt-test" }] }, undefined, undefined, ctx);
    const checkpoint = JSON.parse(fs.readFileSync(started.details.run.checkpointPath, "utf8"));
    assert.equal(checkpoint.nodes[0].model, "openai/gpt-test");
    const inherited = await tool.execute("test", { action: "run", async: true, tasks: [{ id: "inherit", agent: "worker", task: "x", model: "" }] }, undefined, undefined, ctx);
    assert.equal(JSON.parse(fs.readFileSync(inherited.details.run.checkpointPath, "utf8")).nodes[0].model, "cpa/host-model");
    const pinned = await tool.execute("test", { action: "run", async: true, tasks: [{ id: "pinned", agent: "pinned", task: "x" }] }, undefined, undefined, ctx);
    assert.equal(JSON.parse(fs.readFileSync(pinned.details.run.checkpointPath, "utf8")).nodes[0].model, "anthropic/pinned-model");
    await assert.rejects(() => tool.execute("test", { action: "run", async: true, tasks: [{ agent: "worker", task: "x", model: "missing" }] }, undefined, undefined, ctx), /Model is unavailable or ambiguous/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ignores project agents until Pi trusts the project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-trust-"));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "agents", "project-only.md"), "---\nname: project-only\ndescription: project only\n---\nPrompt\n");
  let tool: any;
  try {
    const tools: any[] = [];
    registerPiMesh({ registerTool(value: any) { tools.push(value); if (value.name === "mesh") tool = value; }, getAllTools() { return tools; }, events: { emit() {}, on() { return () => {}; } }, sendMessage() {}, sendUserMessage() {}, registerCommand() {}, registerShortcut() {}, on() {} } as any);
    const execute = (trusted: boolean) => tool.execute("test", { action: "list_agents" }, undefined, undefined, { cwd: root, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "test-session" } } as any);
    const untrusted = await execute(false);
    assert.equal(untrusted.details.agents.some((agent: any) => agent.name === "project-only"), false);
    const trusted = await execute(true);
    const projectAgent = trusted.details.agents.find((agent: any) => agent.name === "project-only");
    assert.equal(projectAgent.filePath, fs.realpathSync(path.join(root, ".pi", "agents", "project-only.md")));
    assert.match(trusted.content[0].text, /definition: .*project-only\.md/);
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
