import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import test from "node:test";

test("test preload strips credentials and fences network and peer namespaces", async () => {
  const root = path.dirname(process.env.HOME!);
  assert.match(path.basename(root), /^pm-test-/);
  assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
  assert.equal(process.env.TMPDIR, path.join(root, "t"));
  assert.equal(process.env.NPM_CONFIG_OFFLINE, "true");
  assert.equal(process.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  assert.equal(Object.keys(process.env).some((key) => /TOKEN|API_KEY|CREDENTIAL|SECRET|PROXY/.test(key)), false);
  await assert.rejects(fetch("https://example.invalid"), /Test network access is disabled/);
  assert.throws(() => net.connect({ host: "127.0.0.1", port: 1 }), /Test network access is disabled/);
  assert.throws(() => net.connect({ path: path.join(path.dirname(root), "not-this-test.sock") }), /Test network access is disabled/);
  const socket = path.join(root, "t", "fixture.sock");
  const server = net.createServer((client) => client.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try {
    await new Promise<void>((resolve, reject) => { const client = net.connect(socket); client.once("error", reject); client.once("close", resolve); });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  assert.equal(fs.existsSync(socket), false);
});

test("derived Node/Pi processes inherit network-only guard without losing fixture environment", async () => {
  const { spawn } = await import("node:child_process");
  const root = process.env.PI_MESH_TEST_PRIVATE_ROOT!;
  const socket = path.join(root, "t", "derived.sock");
  const server = net.createServer((client) => client.end());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const probe = `import net from 'node:net'; import assert from 'node:assert/strict';
      assert.equal(process.env.PI_MESH_TEST_QUEUE, 'fixture-protocol');
      assert.throws(() => net.connect({host:'127.0.0.1',port:1}), /Test network access is disabled/);
      assert.throws(() => net.connect('/tmp/foreign-peer.sock'), /Test network access is disabled/);
      await assert.rejects(fetch('https://example.invalid'), /Test network access is disabled/);
      await new Promise((resolve, reject) => { const c = net.connect(${JSON.stringify(socket)}); c.on('error', reject); c.on('close', resolve); });
      console.log('GUARD_OK');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, PI_MESH_TEST_QUEUE: "fixture-protocol" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve)); assert.equal(code, 0, error); assert.match(output, /GUARD_OK/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("runNode and legacy startChild propagate the private guard to executable fixtures", async () => {
  const { runNode } = await import("../support/e2e.ts");
  const { startChild } = await import("../../src/pi-process.ts");
  const root = process.env.PI_MESH_TEST_PRIVATE_ROOT!; const script = path.join(root, "t", "guard-child.mjs");
  const socket = path.join(root, "t", "tool-child.sock");
  const server = net.createServer((client) => client.end()); await new Promise<void>((resolve) => server.listen(socket, resolve));
  fs.writeFileSync(script, `#!/usr/bin/env node
import assert from 'node:assert/strict'; import net from 'node:net';
assert.equal(process.env.PI_MESH_TEST_QUEUE, 'protocol-kept');
assert.throws(() => net.connect({host:'127.0.0.1',port:1}), /Test network access is disabled/);
assert.throws(() => net.connect('/tmp/outside-private.sock'), /Test network access is disabled/);
await new Promise((resolve, reject) => { const c = net.connect(${JSON.stringify(socket)}); c.on('error', reject); c.on('close', resolve); });
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'DERIVED_GUARD_OK'}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
`, { mode: 0o700 });
  const old = process.env.PI_MESH_PI_BINARY;
  try {
    const result = await runNode(script, [], { ...process.env, PI_MESH_TEST_QUEUE: "protocol-kept" }); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /DERIVED_GUARD_OK/);
    process.env.PI_MESH_PI_BINARY = script;
    const child = startChild({ name: "probe", description: "probe", source: "bundled", filePath: script, systemPrompt: "probe" }, "probe", path.dirname(script), undefined, undefined, { PI_MESH_TEST_QUEUE: "protocol-kept" });
    const answer = await child.completion; assert.equal(answer.exitCode, 0, answer.stderr); assert.equal(answer.output, "DERIVED_GUARD_OK");
  } finally { if (old === undefined) delete process.env.PI_MESH_PI_BINARY; else process.env.PI_MESH_PI_BINARY = old; await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Cross Unix allowance is derived only from this private agentDir, never another peer namespace", async () => {
  const { createHash } = await import("node:crypto");
  const runtime = path.join(fs.realpathSync("/tmp"), `pi-peers-${process.getuid!()}-${createHash("sha256").update(process.env.PI_CODING_AGENT_DIR!).digest("hex").slice(0, 12)}`);
  const socket = path.join(runtime, `${"d".repeat(32)}.sock`);
  fs.mkdirSync(runtime, { mode: 0o700 });
  const server = net.createServer(client => client.end());
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    assert.throws(() => net.connect(path.join(`${runtime}-foreign`, `${"d".repeat(32)}.sock`)), /Test network access is disabled/);
    assert.throws(() => net.connect(path.join(runtime, "not-an-instance.sock")), /Test network access is disabled/);
    await new Promise<void>((resolve, reject) => { const client = net.connect(socket); client.once("error", reject); client.once("close", resolve); });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmdirSync(runtime); }
});
