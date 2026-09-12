import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { SessionAgentManager } from "../../src/session-agents.ts";
import { defaultMeshSettings } from "../../src/settings.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read", "write"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };
function git(cwd: string, ...args: string[]): string { const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }

test("direct Agent worktree preserves changes and leaves the main checkout untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-worktree-")); const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-worktree-q-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
  try {
    git(root, "init"); fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(root, "base.txt"), "base\n"); git(root, "add", "."); git(root, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    fs.writeFileSync(path.join(queue, "pending-001.json"), JSON.stringify({ output: "blocker", delay: 100 }));
    fs.writeFileSync(path.join(queue, "pending-002.json"), JSON.stringify({ output: "done", writeFile: "change.txt", writeContent: "changed" }));
    const manager = new SessionAgentManager({ ...defaultMeshSettings, maxConcurrentAgents: 1 }, root, undefined, "default", undefined, undefined, true);
    const blocker = manager.spawn(agent, "block", "block", root, {});
    const record = manager.spawn(agent, "change", "change", root, { worktree: true });
    assert.equal(record.status, "queued");
    await blocker.promise; await record.promise;
    assert.equal(record.status, "completed"); assert.equal(fs.existsSync(path.join(root, "change.txt")), false);
    await assert.rejects(() => manager.resume(record.id, "again"), /Worktree Agent is not resumable/);
    assert.ok(record.worktree?.finalCommit); assert.ok(record.worktree?.handoffPath && fs.existsSync(record.worktree.handoffPath));
    assert.equal(git(root, "show", `${record.worktree!.finalCommit}:change.txt`), "changed");
    await manager.shutdown();
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true });
  }
});

test("Direct rejects worktree without Host trust and never reports completed after Git handoff failure", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "direct-handoff-fault-")));
  const managers: SessionAgentManager[] = [];
  try {
    const untrusted = new SessionAgentManager(defaultMeshSettings, root); managers.push(untrusted);
    assert.throws(() => untrusted.spawn(agent, "no", "no", root, { worktree: true }), /Host project trust/);
    git(root, "init"); fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(root, "base.txt"), "base"); git(root, "add", "."); git(root, "-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "base");
    const manager = new SessionAgentManager(defaultMeshSettings, root, undefined, "trusted", undefined, undefined, true); managers.push(manager);
    // Simulated execution, real Direct Manager + Git index lock/capture.
    (manager as any).runtime.start = (_a: unknown, options: any) => {
      fs.writeFileSync(path.join(options.cwd, "unique.txt"), "unique");
      fs.writeFileSync(git(options.cwd, "rev-parse", "--git-path", "index.lock"), "lock");
      return { ready: Promise.resolve({ persisted: false }), completion: Promise.resolve({ exitCode: 0, signal: null, output: "done", stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, cost: 0 } }), close: async () => {} };
    };
    const record = manager.spawn(agent, "change", "change", root, { worktree: true }); await record.promise;
    assert.equal(record.status, "failed"); assert.match(record.error!, /Worktree handoff failed/);
    assert.equal(fs.readFileSync(path.join(record.worktree!.path, "unique.txt"), "utf8"), "unique");
  } finally {
    await Promise.all(managers.map((manager) => manager.shutdown()));
    for (const manager of managers) for (const record of manager.list()) if (record.worktree) fs.rmSync(record.worktree.path, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
