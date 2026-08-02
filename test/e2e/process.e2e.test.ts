import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../../src/agents.ts";
import { startChild } from "../../src/pi-process.ts";
import { env, fixture, loadMeshTool, runNode } from "../support/e2e.ts";

const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };

test("run lease excludes a second OS process and releases cleanly", async () => {
  const fx = fixture();
  try {
    const script = path.resolve("test/support/lease-owner.ts");
    const contender = path.resolve("test/support/lease-contender.ts");
    const runId = crypto.randomUUID();
    const result = await runNode(contender, [script, fx.root, runId], process.env);
    assert.equal(result.code, 0);
    const second = JSON.parse(result.stdout);
    assert.equal(second.code, 2);
    assert.match(second.stderr, /already owned/);
    assert.equal((await runNode(script, [fx.root, runId, "0"], process.env)).code, 0);
  } finally { fx.cleanup(); }
});

test("real child process rejects an oversized protocol line", async () => {
  const fx = fixture();
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    fs.writeFileSync(path.join(fx.queue, "pending-001.json"), JSON.stringify({ rawStdoutBytes: 4 * 1024 * 1024 + 1 }));
    const result = await startChild(agent, "large", fx.root).completion;
    assert.match(result.error!, /stdout line exceeded/);
  } finally {
    if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary;
    if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue;
    fx.cleanup();
  }
});

test("real child process keeps only the bounded stderr tail", async () => {
  const fx = fixture();
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    fs.writeFileSync(path.join(fx.queue, "pending-001.json"), JSON.stringify({ output: "bad", stderrBytes: 256 * 1024, exitCode: 1 }));
    const result = await startChild(agent, "stderr", fx.root).completion;
    assert.equal(Buffer.byteLength(result.stderr), 128 * 1024);
    assert.equal(result.error?.length, 128 * 1024);
  } finally {
    if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary;
    if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue;
    fx.cleanup();
  }
});

test("real child process reports signal/cancellation", async () => {
  const fx = fixture();
  const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
  try {
    Object.assign(process.env, env(fx.queue));
    fs.writeFileSync(path.join(fx.queue, "pending-001.json"), JSON.stringify({ output: "late", delay: 5000 }));
    const controller = new AbortController();
    const child = startChild(agent, "slow", fx.root, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await child.completion;
    assert.equal(result.error, "Child cancelled");
    assert.notEqual(result.exitCode, 0);
  } finally {
    if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary;
    if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue;
    fx.cleanup();
  }
});

test("packaged tarball loads through Pi extension loader", async () => {
  const fx = fixture();
  const packageDir = fs.mkdtempSync(path.join(fx.root, "package-"));
  try {
    const { spawnSync } = await import("node:child_process");
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", packageDir], { cwd: path.resolve("."), encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = path.join(packageDir, JSON.parse(packed.stdout)[0].filename);
    const unpack = spawnSync("tar", ["-xzf", tarball, "-C", packageDir], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    const install = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: path.join(packageDir, "package"), encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    const extension = path.join(packageDir, "package", "index.ts");
    const tool = await loadMeshTool(fx.root, extension);
    assert.equal(tool.name, "mesh");
    const old = { binary: process.env.PI_MESH_PI_BINARY, queue: process.env.PI_MESH_TEST_QUEUE };
    try {
      Object.assign(process.env, env(fx.queue));
      fs.writeFileSync(path.join(fx.queue, "pending-001.json"), JSON.stringify({ output: "packaged" }));
      const result = await tool.execute("e2e", { action: "run", tasks: [{ id: "packaged", agent: "worker", task: "run" }] }, new AbortController().signal, undefined, { cwd: fx.root, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "package-e2e" } });
      assert.equal(fs.readFileSync(result.details.run.nodes[0].outputPath, "utf8"), "packaged");
    } finally {
      if (old.binary === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old.binary;
      if (old.queue === undefined) delete process.env.PI_MESH_TEST_QUEUE; else process.env.PI_MESH_TEST_QUEUE = old.queue;
    }
  } finally { fx.cleanup(); }
});
