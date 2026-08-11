import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { MeshManager } from "../../src/manager.ts";
import { PI_MESH_PI_BINARY_ENV } from "../../src/pi-process.ts";
import { discoverWorkflows, instantiateWorkflow } from "../../src/workflows.ts";

const mockPi = path.resolve("test/support/mock-pi.mjs");
const agent = (name: string): AgentDefinition => ({ name, description: name, tools: ["read"], systemPrompt: "Do the task", source: "bundled", filePath: `${name}.md` });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function response(queue: string, index: number, value: object): void {
  fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value));
}
test("executes a composed multi-operator workflow with stage handoffs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-run-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-agent-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-queue-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  try {
    fs.mkdirSync(path.join(root, ".pi", "mesh", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pi", "mesh", "workflows", "composed.yaml"), `maxConcurrency: 2
stages:
  - id: candidates
    operator: parallel
    tasks:
      - { id: a, agent: worker, model: provider/a, task: Candidate A }
      - { id: b, agent: worker, model: provider/b, task: Candidate B }
  - id: debate
    operator: debate
    dependsOn: [candidates]
    tasks:
      - { id: critique, agent: reviewer, task: Critique }
      - { id: rebuttal, agent: analyst, task: Rebuttal }
  - id: final
    operator: supervisor
    dependsOn: [debate]
    tasks:
      - { id: vote-a, agent: reviewer, task: Vote A }
      - { id: vote-b, agent: reviewer, task: Vote B }
      - { id: synthesize, agent: worker, task: Final }
`);
    ["A", "B", "critique", "rebuttal", "vote-a", "vote-b", "final"].forEach((output, index) => fs.writeFileSync(path.join(queue, `pending-${String(index + 1).padStart(3, "0")}.json`), JSON.stringify({ output })));
    process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
    const workflow = instantiateWorkflow(discoverWorkflows(root, agentDir, true)[0]!, {});
    const run = await new MeshManager((name) => agent(name)).start({ cwd: root, operator: workflow.operator, maxConcurrency: workflow.maxConcurrency, tasks: workflow.tasks });
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.nodes.map((node) => node.id), ["candidates.a", "candidates.b", "debate.critique", "debate.rebuttal", "final.vote-a", "final.vote-b", "final.synthesize"]);
    const calls = fs.readdirSync(queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(queue, name), "utf8")));
    const critique = calls.find((call) => call.args.some((value: string) => value.includes("Task: Critique")));
    assert.ok(critique.args.some((value: string) => value.includes("### candidates.a") && value.includes("### candidates.b")));
    const final = calls.find((call) => call.args.some((value: string) => value.includes("Task: Final")));
    assert.ok(final.args.some((value: string) => value.includes("### final.vote-a") && value.includes("### final.vote-b")));
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true });
  }
});

test("executes positional prompt, parallel worktrees, review evidence, and inherited writer chain", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-real-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-real-queue-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-real-agent-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  try {
    git(repo, "init"); fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    const dir = path.join(repo, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "real.yaml"), `promptInput: prompt
worktree: true
maxConcurrency: 2
stages:
  - id: implement
    operator: parallel
    tasks:
      - { id: a, agent: worker, task: "Implement A for {{prompt}}" }
      - { id: b, agent: worker, task: "Implement B for {{prompt}}" }
  - id: review
    operator: graph
    dependsOn: [implement]
    tasks:
      - { id: compare, agent: reviewer, integration: true, task: Compare both candidates }
  - id: revise
    operator: parallel
    dependsOn: [review]
    tasks:
      - { id: a, dependsOn: [implement.a], agent: worker, integration: true, task: Revise A }
      - { id: b, dependsOn: [implement.b], agent: worker, integration: true, task: Revise B }
`);
    response(queue, 1, { output: "Implement A for add OAuth callback validation", writeFile: "a.txt", writeContent: "a" });
    response(queue, 2, { output: "Implement B for add OAuth callback validation", writeFile: "b.txt", writeContent: "b" });
    response(queue, 3, { output: "Compare both candidates" });
    response(queue, 4, { output: "Revise A", writeFile: "a2.txt", writeContent: "a2" });
    response(queue, 5, { output: "Revise B", writeFile: "b2.txt", writeContent: "b2" });
    process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
    const workflow = discoverWorkflows(repo, agentDir, true)[0]!;
    const loaded = instantiateWorkflow(workflow, { [workflow.promptInput!]: "add OAuth callback validation" });
    const run = await new MeshManager((name) => agent(name)).start({ cwd: repo, operator: loaded.operator, worktree: loaded.worktree, maxConcurrency: loaded.maxConcurrency, tasks: loaded.tasks });
    assert.equal(run.status, "succeeded");
    const implementA = run.nodes.find((node) => node.id === "implement.a")!, reviseA = run.nodes.find((node) => node.id === "revise.a")!;
    assert.equal(reviseA.worktree?.baseCommit, implementA.worktree?.finalCommit);
    assert.equal(git(repo, "show", `${reviseA.worktree!.finalCommit}:a.txt`), "a");
    assert.equal(git(repo, "show", `${reviseA.worktree!.finalCommit}:a2.txt`), "a2");
    const calls = fs.readdirSync(queue).filter((name) => name.startsWith("call-")).map((name) => JSON.parse(fs.readFileSync(path.join(queue, name), "utf8")));
    assert.ok(calls.some((call) => call.args.some((value: string) => value.includes("Implement A for add OAuth callback validation"))));
    const review = calls.find((call) => call.args.some((value: string) => value.includes("Task: Compare both candidates")));
    assert.ok(review.args.some((value: string) => value.includes("Commit:") && value.includes("Patch:") && value.includes("Implement A for add OAuth callback validation") && value.includes("Implement B for add OAuth callback validation")));
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("fails a composed workflow without running dependent stages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-fail-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-fail-queue-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflow-fail-agent-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  try {
    const dir = path.join(root, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "failure.yaml"), `failFast: true
stages:
  - id: parallel
    operator: parallel
    tasks:
      - { id: good, agent: worker, task: Good }
      - { id: bad, agent: worker, task: Bad }
  - id: final
    operator: graph
    dependsOn: [parallel]
    tasks:
      - { id: summarize, agent: planner, task: Must not run }
`);
    response(queue, 1, { output: "Good" }); response(queue, 2, { output: "bad", stderr: "expected failure", exitCode: 1 });
    process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
    const workflow = discoverWorkflows(root, agentDir, true)[0]!;
    const run = await new MeshManager((name) => agent(name)).start({ cwd: root, operator: workflow.operator, failFast: workflow.failFast, tasks: workflow.tasks });
    assert.equal(run.status, "failed");
    assert.equal(run.nodes.find((node) => node.id === "parallel.bad")?.status, "failed");
    assert.equal(run.nodes.find((node) => node.id === "final.summarize")?.status, "skipped");
    assert.equal(fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length, 2);
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("executes the shipped 18-node consensus topology end to end", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-consensus-run-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-consensus-queue-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-consensus-agent-"));
  const oldBinary = process.env[PI_MESH_PI_BINARY_ENV], oldQueue = process.env.PI_MESH_TEST_QUEUE;
  try {
    git(repo, "init"); fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    const dir = path.join(repo, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.resolve("workflows/consensus.yaml"), path.join(dir, "consensus-yaml.yaml"));
    for (let index = 1; index <= 18; index++) response(queue, index, { output: `result-${index}`, ...(index <= 3 || (index >= 8 && index <= 10) || (index >= 15 && index <= 18) ? { writeFile: `change-${index}.txt`, writeContent: `change-${index}` } : {}) });
    process.env[PI_MESH_PI_BINARY_ENV] = mockPi; process.env.PI_MESH_TEST_QUEUE = queue;
    const workflow = discoverWorkflows(repo, agentDir, true)[0]!;
    const loaded = instantiateWorkflow(workflow, { [workflow.promptInput!]: "implement secure OAuth callback validation" });
    const run = await new MeshManager((name) => agent(name)).start({ cwd: repo, operator: loaded.operator, worktree: loaded.worktree, maxConcurrency: loaded.maxConcurrency, maxNodes: loaded.maxNodes, failFast: loaded.failFast, tasks: loaded.tasks });
    assert.equal(run.status, "succeeded");
    assert.equal(run.nodes.length, 18);
    assert.ok(run.nodes.every((node) => node.status === "succeeded"));
    assert.equal(run.nodes.find((node) => node.id === "final.integrate")?.dependsOn.length, 4);
    assert.ok(run.nodes.find((node) => node.id === "final.integrate")?.worktree?.finalCommit);
    assert.equal(fs.readdirSync(queue).filter((name) => name.startsWith("call-")).length, 18);
  } finally {
    if (oldBinary === undefined) delete process.env[PI_MESH_PI_BINARY_ENV]; else process.env[PI_MESH_PI_BINARY_ENV] = oldBinary;
    if (oldQueue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = oldQueue;
    fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
