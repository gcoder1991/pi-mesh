import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMeshSettings, meshSettingsFiles } from "../../src/settings.ts";

test("loads global mesh settings and project overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-settings-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    fs.mkdirSync(path.join(agentDir, "mesh"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi", "mesh"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "mesh", "settings.yaml"), "maxAgentDepth: 6\nmaxConcurrentAgents: 3\ndebug: true\n");
    fs.writeFileSync(path.join(cwd, ".pi", "mesh", "settings.yaml"), "maxConcurrentAgents: 2\nmaxNodes: 20\nchildExtensions:\n  mcp: ./mcp.ts\nchildSkills:\n  browser: ./browser/SKILL.md\n");
    assert.deepEqual(loadMeshSettings(cwd, { PI_CODING_AGENT_DIR: agentDir }), { maxAgentDepth: 6, maxConcurrentAgents: 2, maxNodes: 20, messagePayloadMaxBytes: 32768, recipientUnreadMaxBytes: 1048576, childExtensions: { mcp: path.join(cwd, ".pi", "mesh", "mcp.ts") }, childSkills: { browser: path.join(cwd, ".pi", "mesh", "browser", "SKILL.md") }, joinMode: "smart", debug: true, retentionDays: 30, maxTerminalRuns: 100, debugMaxBytes: 4 * 1024 * 1024 });
    assert.deepEqual(meshSettingsFiles(cwd, { PI_CODING_AGENT_DIR: agentDir }), [path.join(agentDir, "mesh", "settings.yaml"), path.join(cwd, ".pi", "mesh", "settings.yaml")]);
    const globalOnly = loadMeshSettings(cwd, { PI_CODING_AGENT_DIR: agentDir }, false);
    assert.equal(globalOnly.maxConcurrentAgents, 3);
    assert.equal(globalOnly.maxNodes, 128);
    assert.deepEqual(globalOnly.childExtensions, {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects unknown or invalid mesh settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-settings-"));
  try {
    const file = path.join(root, "mesh", "settings.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "maxConcurrentAgents: 0\n");
    assert.throws(() => loadMeshSettings(root, { PI_CODING_AGENT_DIR: root }), /maxConcurrentAgents must be 1-32/);
    fs.writeFileSync(file, "unknown: true\n");
    assert.throws(() => loadMeshSettings(root, { PI_CODING_AGENT_DIR: root }), /unknown key unknown/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
