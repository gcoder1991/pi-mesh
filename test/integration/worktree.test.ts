import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { MeshManager } from "../../src/manager.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["bash"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(fn: (repo: string, queue: string) => Promise<void>): Promise<void> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-worktree-repo-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-worktree-queue-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV];
  const oldQueue = process.env.PI_MESH_TEST_QUEUE;
  try {
    git(repo, "init");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    process.env[PI_MESH_PI_BINARY_ENV] = mockPi;
    process.env.PI_MESH_TEST_QUEUE = queue;
    await fn(repo, queue);
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(queue, { recursive: true, force: true });
  }
}

function response(queue: string, index: number, value: object): void {
  fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value));
}

test("parallel writers use isolated worktrees and produce handoffs", async () => fixture(async (repo, queue) => {
  response(queue, 1, { output: "one", writeFile: "one.txt", writeContent: "one" });
  response(queue, 2, { output: "two", writeFile: "two.txt", writeContent: "two" });
  const manager = new MeshManager(() => agent);
  const run = await manager.start({
    cwd: repo,
    worktree: true,
    operator: "parallel",
    maxConcurrency: 2,
    tasks: [
      { id: "one", agent: "worker", task: "one" },
      { id: "two", agent: "worker", task: "two" },
    ],
  });

  assert.equal(run.status, "succeeded");
  assert.equal(fs.existsSync(path.join(repo, "one.txt")), false);
  assert.equal(fs.existsSync(path.join(repo, "two.txt")), false);
  assert.notEqual(run.nodes[0].worktree?.cwd, run.nodes[1].worktree?.cwd);
  for (const node of run.nodes) {
    assert.equal(node.worktree?.cleanupStatus, "complete");
    assert.equal(node.worktree?.filesChanged, 1);
    assert.ok(node.worktree?.branch);
    assert.ok(node.worktree?.patchPath && fs.existsSync(node.worktree.patchPath));
    assert.ok(node.worktree?.handoffPath && fs.existsSync(node.worktree.handoffPath));
    const handoff = JSON.parse(fs.readFileSync(node.worktree!.handoffPath!, "utf8"));
    assert.equal(handoff.schema, "pi-mesh.handoff/v1");
    assert.equal(handoff.baseCommit, node.worktree?.baseCommit);
    assert.equal(handoff.finalCommit, node.worktree?.finalCommit);
    assert.equal(handoff.filesChanged, 1);
    assert.equal(node.worktreeHistory?.length, 1);
    assert.equal(fs.existsSync(node.worktree!.path), false);
    assert.equal(git(repo, "show-ref", "--verify", `refs/heads/${node.worktree!.branch}`).length > 0, true);
    const applied = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-patch-"));
    git(repo, "worktree", "add", "--detach", applied, node.worktree!.baseCommit);
    try {
      const apply = spawnSync("git", ["-C", applied, "apply", node.worktree!.patchPath!], { encoding: "utf8" });
      assert.equal(apply.status, 0, apply.stderr);
      assert.equal(fs.existsSync(path.join(applied, `${node.id}.txt`)), true);
    } finally {
      git(repo, "worktree", "remove", "--force", applied);
    }
  }
}));

test("single writer dependency starts from predecessor commit", async () => fixture(async (repo, queue) => {
  response(queue, 1, { output: "one", writeFile: "one.txt", writeContent: "one" });
  response(queue, 2, { output: "two", writeFile: "two.txt", writeContent: "two" });
  const manager = new MeshManager(() => agent);
  const run = await manager.start({ cwd: repo, worktree: true, tasks: [
    { id: "one", agent: "worker", task: "one" },
    { id: "two", agent: "worker", task: "two", dependsOn: ["one"] },
  ] });
  assert.equal(run.status, "succeeded");
  assert.equal(run.nodes[1].worktree?.baseCommit, run.nodes[0].worktree?.finalCommit);
  const final = run.nodes[1].worktree!.finalCommit!;
  assert.equal(git(repo, "show", `${final}:one.txt`), "one");
  assert.equal(git(repo, "show", `${final}:two.txt`), "two");
}));

test("worktree mode rejects dirty repositories before spawning", async () => fixture(async (repo, queue) => {
  fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty");
  const manager = new MeshManager(() => agent);
  await assert.rejects(() => manager.start({ cwd: repo, worktree: true, tasks: [{ agent: "worker", task: "write" }] }), /clean git working tree/);
  assert.equal(fs.readdirSync(queue).some((name) => name.startsWith("call-")), false);
}));

test("worktree setup hook must stay inside the repository", async () => fixture(async (repo, queue) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-worktree-hook-"));
  try {
    const hook = path.join(outside, "setup.sh");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const manager = new MeshManager(() => agent);
    await assert.rejects(() => manager.start({ cwd: repo, worktree: true, worktreeSetupHook: hook, tasks: [{ agent: "worker", task: "write" }] }), /setup hook must be inside repository/);
    assert.equal(fs.readdirSync(queue).some((name) => name.startsWith("call-")), false);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));
