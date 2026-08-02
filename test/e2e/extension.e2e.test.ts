import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { env, execute, fixture, gitRun, loadMeshTool, response } from "../support/e2e.ts";

function restore(old: { binary?: string; queue?: string }, cleanup: () => void): void {
  if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary;
  if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue;
  cleanup();
}

test("Pi loader executes a dependency graph through real child processes", async () => {
  const fx = fixture();
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    response(fx.queue, 1, { output: "inspect evidence" });
    response(fx.queue, 2, { output: "fixed" });
    const tool = await loadMeshTool(fx.root);
    const result = await execute(tool, fx.root, { action: "run", tasks: [
      { id: "inspect", agent: "scout", task: "inspect" },
      { id: "fix", agent: "worker", task: "fix", dependsOn: ["inspect"] },
    ] });
    assert.equal(result.details.run.status, "succeeded");
    assert.equal(result.usage.totalTokens, 4);
    assert.equal(result.usage.cost.total, 0);
    assert.equal(fs.readFileSync(result.details.run.nodes[1].outputPath, "utf8"), "fixed");
    const calls = fs.readdirSync(fx.queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(fx.queue, name), "utf8")));
    assert.ok(calls.some((call) => call.args.some((arg: string) => arg.includes("Direct dependency evidence") && arg.includes("inspect evidence"))));
    assert.ok(fs.existsSync(result.details.run.nodes[0].outputPath));
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
    assert.equal(JSON.stringify(result.details).includes("inspect evidence"), false);
    const diagnostic = JSON.parse(fs.readFileSync(result.details.run.nodes[0].attemptResultPath, "utf8"));
    assert.equal(diagnostic.status, "succeeded");
    assert.equal(diagnostic.exitCode, 0);
    assert.equal(diagnostic.outputPath, result.details.run.nodes[0].outputPath);
  } finally { restore(old, fx.cleanup); }
});

test("async run reports validation errors before returning a run id", async () => {
  const fx = fixture();
  try {
    const tool = await loadMeshTool(fx.root);
    await assert.rejects(() => execute(tool, fx.root, { action: "run", async: true, tasks: [{ agent: "missing", task: "bad" }] }), /Unknown agent: missing/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => execute(tool, fx.root, { action: "run", async: true, tasks: [{ agent: "worker", task: "bad" }] }, controller.signal), /cancelled before creation/);
  } finally { fx.cleanup(); }
});

test("Pi loader stores large output as a bounded checkpoint preview", async () => {
  const fx = fixture();
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    const large = "界".repeat(90_000);
    response(fx.queue, 1, { output: large });
    const tool = await loadMeshTool(fx.root);
    const result = await execute(tool, fx.root, { action: "run", tasks: [{ id: "large", agent: "worker", task: "large" }] });
    const node = result.details.run.nodes[0];
    assert.equal(node.outputTruncated, true);
    assert.equal(fs.readFileSync(node.outputPath, "utf8"), large);
    const checkpoint = fs.readFileSync(path.join(fx.root, ".pi", "mesh", "runs", `${result.details.run.id}.json`), "utf8");
    assert.ok(Buffer.byteLength(checkpoint) < node.outputBytes);
  } finally { restore(old, fx.cleanup); }
});

test("Pi loader preserves writer handoffs and inherited commits", async () => {
  const fx = fixture(true);
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    response(fx.queue, 1, { output: "first", writeFile: "first.txt", writeContent: "first" });
    response(fx.queue, 2, { output: "second", writeFile: "second.txt", writeContent: "second" });
    const tool = await loadMeshTool(fx.root);
    const result = await execute(tool, fx.root, { action: "run", worktree: true, tasks: [
      { id: "first", agent: "worker", task: "first" },
      { id: "second", agent: "worker", task: "second", dependsOn: ["first"] },
    ] });
    const run = result.details.run;
    assert.equal(run.status, "succeeded");
    assert.equal(run.nodes[1].worktree.baseCommit, run.nodes[0].worktree.finalCommit);
    assert.equal(gitRun(fx.root, "show", `${run.nodes[1].worktree.finalCommit}:first.txt`), "first");
    assert.equal(gitRun(fx.root, "show", `${run.nodes[1].worktree.finalCommit}:second.txt`), "second");
    const handoffs = await execute(tool, fx.root, { action: "handoff_list", runId: run.id });
    assert.equal(handoffs.details.handoffs.length, 2);
    assert.match(handoffs.content[0].text, /git cherry-pick/);
    assert.equal(fs.existsSync(path.join(fx.root, "first.txt")), false);
  } finally { restore(old, fx.cleanup); }
});

test("parallel writers launch in separate worktrees", async () => {
  const fx = fixture(true);
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    response(fx.queue, 1, { output: "one", delay: 100, writeFile: "one.txt", writeContent: "one" });
    response(fx.queue, 2, { output: "two", delay: 100, writeFile: "two.txt", writeContent: "two" });
    const tool = await loadMeshTool(fx.root);
    const result = await execute(tool, fx.root, { action: "run", operator: "parallel", worktree: true, maxConcurrency: 2, tasks: [
      { id: "one", agent: "worker", task: "one" }, { id: "two", agent: "worker", task: "two" },
    ] });
    const [one, two] = result.details.run.nodes;
    assert.equal(result.details.run.status, "succeeded");
    assert.notEqual(one.worktree.path, two.worktree.path);
    const calls = fs.readdirSync(fx.queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(fx.queue, name), "utf8")));
    assert.equal(new Set(calls.map((call) => call.cwd)).size, 2);
    assert.equal(fs.existsSync(path.join(fx.root, "one.txt")), false);
    assert.equal(fs.existsSync(path.join(fx.root, "two.txt")), false);
  } finally { restore(old, fx.cleanup); }
});

test("no-change worktree nodes succeed and leave no temporary branch", async () => {
  const fx = fixture(true);
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    response(fx.queue, 1, { output: "reviewed" });
    const tool = await loadMeshTool(fx.root);
    const result = await execute(tool, fx.root, { action: "run", worktree: true, tasks: [{ id: "review", agent: "reviewer", task: "review" }] });
    const state = result.details.run.nodes[0].worktree;
    assert.equal(result.details.run.status, "succeeded");
    assert.equal(state.filesChanged, 0);
    assert.equal(state.cleanupStatus, "complete");
    assert.equal(gitRun(fx.root, "branch", "--list", state.branch), "");
  } finally { restore(old, fx.cleanup); }
});
