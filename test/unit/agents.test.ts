import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "../../src/agents.ts";

test("discovers bundled agents", () => {
  const agents = discoverAgents(process.cwd(), "bundled");
  assert.deepEqual(agents.map((agent) => agent.name), ["analyst", "planner", "qa", "reviewer", "scout", "worker"]);
  const scout = agents.find((agent) => agent.name === "scout");
  assert.equal(scout?.source, "bundled");
  assert.match(scout?.description ?? "", /broad codebase exploration/);
  assert.match(agents.find((agent) => agent.name === "analyst")?.description ?? "", /vague or conflicting/);
  assert.match(agents.find((agent) => agent.name === "planner")?.description ?? "", /unresolved design boundaries/);
  assert.match(agents.find((agent) => agent.name === "qa")?.description ?? "", /artifact-backed/);
});

test("ignores symlinked agent definitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-link-"));
  const dir = path.join(root, ".pi", "agents");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(root, "outside.md");
    fs.writeFileSync(target, "---\nname: linked\ndescription: linked\n---\nPrompt\n");
    fs.symlinkSync(target, path.join(dir, "linked.md"));
    assert.equal(discoverAgents(root, "project").some((agent) => agent.name === "linked"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ignores a symlinked agents directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-dir-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-outside-"));
  try {
    fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(outside, "linked.md"), "---\nname: linked-dir\ndescription: linked\n---\nPrompt\n");
    fs.symlinkSync(outside, path.join(root, ".pi", "agents"));
    assert.equal(discoverAgents(root, "project").some((agent) => agent.name === "linked-dir"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("loads compatibility frontmatter and filename fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-compat-"));
  const dir = path.join(root, ".pi", "agents");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "compat.md"), "---\ndescription: Compatible agent\ntools: read, bash\ndisallowed_tools: bash\nthinking: high\nmax_turns: 12\nprompt_mode: append\nextensions: mcp\nskills: browser\npersist_session: true\noutput_transcript: false\n---\nPrompt\n");
    const agent = discoverAgents(root, "project").find((item) => item.name === "compat");
    assert.deepEqual(agent && { name: agent.name, tools: agent.tools, disallowedTools: agent.disallowedTools, thinking: agent.thinking, maxTurns: agent.maxTurns, promptMode: agent.promptMode, extensions: agent.extensions, skills: agent.skills, persistSession: agent.persistSession, outputTranscript: agent.outputTranscript }, { name: "compat", tools: ["read", "bash"], disallowedTools: ["bash"], thinking: "high", maxTurns: 12, promptMode: "append", extensions: ["mcp"], skills: ["browser"], persistSession: true, outputTranscript: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects wildcard and path child resources in agent files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-resource-"));
  const dir = path.join(root, ".pi", "agents");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.md"), "---\ndescription: Bad\nextensions: '*'\n---\nPrompt\n");
    assert.equal(discoverAgents(root, "project").some((item) => item.name === "bad"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("nearest project agents override bundled agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agents-"));
  const nested = path.join(root, "a", "b");
  const dir = path.join(root, ".pi", "agents");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scout.md"), "---\nname: scout\ndescription: project scout\ntools: read\n---\nProject prompt");
  try {
    const scout = discoverAgents(nested, "all").find((agent) => agent.name === "scout");
    assert.equal(scout?.source, "project");
    assert.equal(scout?.description, "project scout");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
