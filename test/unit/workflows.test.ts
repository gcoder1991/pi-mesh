import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkflows, instantiateWorkflow, parseWorkflowInputs } from "../../src/workflows.ts";

function fixture(fn: (root: string, agentDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-workflows-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-agent-dir-"));
  try { fn(root, agentDir); } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true }); }
}

test("discovers global workflows and lets trusted project commands override them", () => fixture((root, agentDir) => {
  fs.mkdirSync(path.join(agentDir, "mesh", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "mesh", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "mesh", "workflows", "review.yaml"), "description: global\ntasks:\n  - agent: scout\n    task: global\n");
  fs.writeFileSync(path.join(root, ".pi", "mesh", "workflows", "review.yaml"), "description: project\ntasks:\n  - agent: worker\n    task: project\n");
  assert.equal(discoverWorkflows(root, agentDir, false)[0]?.source, "global");
  const trusted = discoverWorkflows(root, agentDir, true)[0]!;
  assert.equal(trusted.source, "project");
  assert.equal(trusted.tasks[0]?.task, "project");
}));

test("instantiates simple placeholders with defaults and key=value overrides", () => fixture((root, agentDir) => {
  const dir = path.join(root, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review.yaml"), "inputs:\n  focus: bugs\ntasks:\n  - id: inspect\n    agent: scout\n    task: Review {{target}} for {{focus}}\n");
  const workflow = discoverWorkflows(root, agentDir, true)[0]!;
  const loaded = instantiateWorkflow(workflow, parseWorkflowInputs("target=src focus=regressions"));
  assert.equal(loaded.tasks[0]?.task, "Review src for regressions");
  assert.throws(() => instantiateWorkflow(workflow, {}), /Missing workflow input: target/);
}));

test("rejects malformed workflow arguments and unknown top-level keys", () => fixture((root, agentDir) => {
  assert.throws(() => parseWorkflowInputs("target"), /Expected key=value/);
  const dir = path.join(root, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bad.yaml"), "execute: rm -rf /\ntasks:\n  - agent: worker\n    task: bad\n");
  assert.equal(discoverWorkflows(root, agentDir, true).length, 0);
  fs.rmSync(path.join(dir, "bad.yaml"));
  fs.writeFileSync(path.join(dir, "consensus.yaml"), "tasks:\n  - agent: worker\n    task: bad\n");
  assert.equal(discoverWorkflows(root, agentDir, true).length, 0);
}));

test("composes multiple operator stages into one dependency graph", () => fixture((root, agentDir) => {
  const dir = path.join(root, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "composed.yaml"), `worktree: true
stages:
  - id: candidates
    operator: parallel
    tasks:
      - id: a
        agent: worker
        model: provider/a
        task: Implement A
      - id: b
        agent: worker
        model: provider/b
        task: Implement B
  - id: debate
    operator: debate
    dependsOn: [candidates]
    tasks:
      - id: critique
        agent: reviewer
        integration: true
        task: Compare candidates
      - id: response
        agent: analyst
        task: Resolve objections
  - id: final
    operator: supervisor
    dependsOn: [debate]
    tasks:
      - id: vote-a
        agent: reviewer
        task: Vote A
      - id: vote-b
        agent: reviewer
        task: Vote B
      - id: integrate
        agent: worker
        task: Integrate winner
`);
  const workflow = discoverWorkflows(root, agentDir, true)[0]!;
  assert.equal(workflow.operator, "graph");
  assert.deepEqual(workflow.tasks.map((task) => task.id), ["candidates.a", "candidates.b", "debate.critique", "debate.response", "final.vote-a", "final.vote-b", "final.integrate"]);
  assert.deepEqual(workflow.tasks[2]?.dependsOn, ["candidates.a", "candidates.b"]);
  assert.deepEqual(workflow.tasks[3]?.dependsOn, ["debate.critique"]);
  assert.deepEqual(workflow.tasks[4]?.dependsOn, ["debate.response"]);
  assert.deepEqual(workflow.tasks[6]?.dependsOn, ["final.vote-a", "final.vote-b"]);
}));

test("ships an 18-node two-round consensus workflow", () => {
  const file = path.resolve("workflows/consensus.yaml");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-shipped-workflow-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-shipped-agent-"));
  try {
    const dir = path.join(agentDir, "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, "consensus.yaml"));
    const workflow = discoverWorkflows(root, agentDir, false)[0]!;
    const loaded = instantiateWorkflow(workflow, { ...parseWorkflowInputs("Implement authentication safely with OAuth", workflow.promptInput), modelA: "provider/a", modelB: "provider/b", modelC: "provider/c", finalizer: "provider/final" });
    assert.equal(loaded.tasks.length, 18);
    assert.equal(loaded.operator, "graph");
    assert.equal(loaded.worktree, true);
    assert.equal(loaded.maxNodes, 18);
    assert.equal(workflow.promptInput, "task");
    assert.match(loaded.tasks[0]?.task ?? "", /Implement authentication safely with OAuth/);
    assert.deepEqual(loaded.tasks.slice(0, 3).map((task) => task.model), ["provider/a", "provider/b", "provider/c"]);
    assert.deepEqual(loaded.tasks.find((task) => task.id === "revise1.a")?.dependsOn, ["implement.a", "ledger1.normalize"]);
    assert.deepEqual(loaded.tasks.find((task) => task.id === "revise2.a")?.dependsOn, ["revise1.a", "ledger2.normalize"]);
    assert.deepEqual(loaded.tasks.find((task) => task.id === "final.integrate")?.dependsOn, ["ledger2.normalize", "revise2.a", "revise2.b", "revise2.c"]);
    assert.equal(loaded.tasks.find((task) => task.id === "final.integrate")?.integration, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true }); }
});

test("isolates bad files, validates task fields, and handles prototype-like inputs safely", () => fixture((root, agentDir) => {
  const dir = path.join(root, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "valid.yaml"), "tasks:\n  - agent: worker\n    task: '{{constructor}} {{toString}}'\n");
  fs.writeFileSync(path.join(dir, "bad.yaml"), "tasks:\n  - agent: worker\n    task: bad\n    integration: 'false'\n");
  const workflows = discoverWorkflows(root, agentDir, true);
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]?.name, "valid");
  assert.throws(() => instantiateWorkflow(workflows[0]!, {}), /Missing workflow input: constructor/);
  assert.equal(Object.hasOwn(parseWorkflowInputs("constructor=x"), "constructor"), true);
  assert.equal(Object.getPrototypeOf(parseWorkflowInputs("constructor=x")), null);
}));

test("rejects host command collisions", () => fixture((root, agentDir) => {
  const dir = path.join(root, ".pi", "mesh", "workflows"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.yaml"), "tasks:\n  - agent: worker\n    task: bad\n");
  assert.equal(discoverWorkflows(root, agentDir, true).length, 0);
}));
