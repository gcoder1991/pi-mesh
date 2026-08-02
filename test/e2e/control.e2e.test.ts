import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { atomicWrite, growthProposals, messages, runFile } from "../../src/store.ts";
import type { MeshRun } from "../../src/manager.ts";
import { execute, fixture, loadMeshTool } from "../support/e2e.ts";

function activeRun(cwd: string): MeshRun {
  const now = Date.now();
  return { schema: "pi-mesh.run/v2", id: crypto.randomUUID(), status: "paused", cwd, maxConcurrency: 2, maxNodes: 8, failFast: false,
    operator: "graph", revision: 4, recoveryCount: 0, messagePayloadMaxBytes: 8, recipientUnreadMaxBytes: 10, createdAt: now, updatedAt: now, nodes: [
      { id: "a", agent: "worker", task: "a", dependsOn: [], cwd, retries: 0, attempt: 1, status: "paused" },
      { id: "b", agent: "worker", task: "b", dependsOn: [], cwd, retries: 0, attempt: 1, status: "paused" },
    ] };
}

test("host mailbox validates recipients and atomically acknowledges", async () => {
  const fx = fixture();
  try {
    const run = activeRun(fx.root);
    atomicWrite(runFile(fx.root, run.id), run);
    const tool = await loadMeshTool(fx.root);
    await execute(tool, fx.root, { action: "message_send", runId: run.id, from: "host", to: "a", content: "hello" });
    await assert.rejects(() => execute(tool, fx.root, { action: "message_send", runId: run.id, to: "missing", content: "bad" }), /Unknown recipient/);
    await assert.rejects(() => execute(tool, fx.root, { action: "message_send", runId: run.id, to: "a", content: "x".repeat(32769) }), /payload exceeds 32768/);
    const inbox = await execute(tool, fx.root, { action: "message_inbox", runId: run.id, nodeId: "a" });
    const id = inbox.details.inbox[0].id;
    await execute(tool, fx.root, { action: "message_ack", runId: run.id, nodeId: "a", messageId: id });
    await assert.rejects(() => execute(tool, fx.root, { action: "message_ack", runId: run.id, nodeId: "a", messageId: id }), /unacked delivery/);
    assert.ok(messages(fx.root, run.id)[0]?.ackedAt);
  } finally { fx.cleanup(); }
});

test("child control extension proposes fenced growth and uses graph membership", async () => {
  const fx = fixture();
  const prior = { run: process.env.PI_MESH_RUN_ID, node: process.env.PI_MESH_NODE_ID, attempt: process.env.PI_MESH_ATTEMPT, root: process.env.PI_MESH_ROOT };
  try {
    const run = activeRun(fx.root);
    atomicWrite(runFile(fx.root, run.id), run);
    run.status = "running"; run.nodes[0].status = "running"; run.nodes[0].allowedSubagents = ["reviewer"]; atomicWrite(runFile(fx.root, run.id), run);
    process.env.PI_MESH_RUN_ID = run.id; process.env.PI_MESH_NODE_ID = "a"; process.env.PI_MESH_ATTEMPT = "1"; process.env.PI_MESH_ROOT = fx.root;
    const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
    const loaded = await discoverAndLoadExtensions([path.resolve("src/control-extension.ts")], fx.root);
    const control = loaded.extensions[0].tools.get("mesh_control")!.definition;
    await control.execute("e2e", { action: "broadcast", content: "all" }, new AbortController().signal, undefined, { cwd: fx.root } as any);
    assert.deepEqual(messages(fx.root, run.id).map((message) => message.to), ["b"]);
    await assert.rejects(() => control.execute("e2e", { action: "grow", reason: "qa", tasks: [{ id: "qa", agent: "qa", task: "qa" }] }, new AbortController().signal, undefined, { cwd: fx.root } as any), /cannot request growth for: qa/);
    await control.execute("e2e", { action: "grow", reason: "review", tasks: [{ id: "review", agent: "reviewer", task: "review" }] }, new AbortController().signal, undefined, { cwd: fx.root } as any);
    const proposal = growthProposals(fx.root, run.id)[0];
    assert.equal(proposal.baseRevision, run.revision);
    assert.equal(proposal.requesterAttempt, 1);
    let meshTool = await loadMeshTool(fx.root);
    const checkpoint = JSON.parse(fs.readFileSync(runFile(fx.root, run.id), "utf8")); checkpoint.status = "paused"; checkpoint.nodes[0].status = "paused"; atomicWrite(runFile(fx.root, run.id), checkpoint);
    const decided = await execute(meshTool, fx.root, { action: "growth_decide", runId: run.id, proposalId: proposal.id, decision: "approve" });
    assert.match(decided.content[0].text, /Growth committed/);
    const staleRun = JSON.parse(fs.readFileSync(runFile(fx.root, run.id), "utf8")); staleRun.status = "running"; staleRun.nodes[0].status = "running"; staleRun.nodes[0].attempt = 1; atomicWrite(runFile(fx.root, run.id), staleRun);
    await control.execute("e2e", { action: "grow", reason: "review stale", tasks: [{ id: "review-stale", agent: "reviewer", task: "review" }] }, new AbortController().signal, undefined, { cwd: fx.root } as any);
    const staleProposal = growthProposals(fx.root, run.id).find((item) => item.id !== proposal.id)!; const latestRun = JSON.parse(fs.readFileSync(runFile(fx.root, run.id), "utf8")); latestRun.revision = staleProposal.baseRevision + 1; atomicWrite(runFile(fx.root, run.id), latestRun);
    meshTool = await loadMeshTool(fx.root);
    await assert.rejects(() => execute(meshTool, fx.root, { action: "growth_decide", runId: run.id, proposalId: staleProposal.id, decision: "approve" }), /requester\/revision is stale/);
    const persisted = JSON.parse(fs.readFileSync(runFile(fx.root, run.id), "utf8")); persisted.nodes[0].attempt = 2; atomicWrite(runFile(fx.root, run.id), persisted);
    await assert.rejects(() => control.execute("e2e", { action: "send", to: "b", content: "stale" }, new AbortController().signal, undefined, { cwd: fx.root } as any), /identity is no longer active/);
  } finally {
    if (prior.run === undefined) delete process.env.PI_MESH_RUN_ID; else process.env.PI_MESH_RUN_ID = prior.run;
    if (prior.node === undefined) delete process.env.PI_MESH_NODE_ID; else process.env.PI_MESH_NODE_ID = prior.node;
    if (prior.attempt === undefined) delete process.env.PI_MESH_ATTEMPT; else process.env.PI_MESH_ATTEMPT = prior.attempt;
    if (prior.root === undefined) delete process.env.PI_MESH_ROOT; else process.env.PI_MESH_ROOT = prior.root;
    fx.cleanup();
  }
});

test("corrupt mailbox state fails closed without hiding valid messages", async () => {
  const fx = fixture();
  try {
    const run = activeRun(fx.root);
    atomicWrite(runFile(fx.root, run.id), run);
    const dir = path.join(fx.root, ".pi", "mesh", "messages", run.id);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, "valid.json"), { id: "valid", runId: run.id, from: "host", to: "a", content: "ok", createdAt: 1 });
    fs.writeFileSync(path.join(dir, "broken.json"), "{");
    const tool = await loadMeshTool(fx.root);
    await assert.rejects(() => execute(tool, fx.root, { action: "message_inbox", runId: run.id, nodeId: "a" }), /Invalid JSON state/);
  } finally { fx.cleanup(); }
});
