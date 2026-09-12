import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { MeshManager } from "../../src/manager.ts";
import { defaultMeshSettings, bridgeTarget } from "../../src/settings.ts";
import { messages, putMessage, ackMessage } from "../../src/store.ts";
const worker = path.resolve('test/support/bridge-process-worker.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw new Error('OS barrier timeout'); await sleep(10); } }
async function fixture(fn: (root: string, launch: (name: string, config: any) => any) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-process-'))); const children: any[] = [];
  fs.mkdirSync(path.join(root, 'agent'));
  function launch(name: string, config: any) {
    const file = path.join(root, `${name}.config`); fs.writeFileSync(file, JSON.stringify({ root, name, ...config }));
    const child = spawn(process.execPath, ['--experimental-strip-types', worker, file], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let log = ''; child.stdout.on('data', (v: Buffer) => log += v); child.stderr.on('data', (v: Buffer) => log += v);
    const done = new Promise<any>((resolve, reject) => { child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(`Worker ${name} exit ${code}: ${log}`)); else { const result = JSON.parse(fs.readFileSync(path.join(root, `${name}.result`), 'utf8')); console.log('BRIDGE_PROCESS_ACTUAL', JSON.stringify({ name, mode: config.mode, barrier: config.barrier, fault: config.fault, pid: result.pid, hits: result.hits, releaseHits: result.releaseHits, unreadable: result.unreadable, outcome: result.outcome, admission: result.admission, totalUsed: result.status?.totalUsed, canonicalCount: result.status?.evidenceCount, failureCount: result.status?.failureCount, inboxCount: result.inbox?.count, selectedCount: result.selected?.count, mailboxCount: result.mailbox?.length, sends: result.sends })); resolve(result); } }); });
    void done.catch(() => {});
    return { child, done, async paused() { await until(() => fs.existsSync(path.join(root, `${name}.paused`))); }, resume() { child.kill('SIGCONT'); } };
  }
  try { await fn(root, launch); } finally { for (const c of children) if (c.exitCode === null) { c.kill('SIGCONT'); c.kill('SIGKILL'); } fs.rmSync(root, { recursive: true, force: true }); }
}
async function setup(root: string, count = 0, total = false) {
  const manager = new MeshManager(() => ({ name: 'test', description: 'test', systemPrompt: 'test', source: 'bundled', filePath: 'fixture' }), defaultMeshSettings, undefined, undefined, 'host', true);
  const run = manager.create({ cwd: root, tasks: [{ id: 'a', agent: 'test', task: 'not started' }] });
  const target = bridgeTarget({ kind: 'mesh', root, sessionId: 'host', runId: run.id, nodeId: 'a', attempt: 0 });
  fs.mkdirSync(path.join(root, 'agent/mesh'));
  fs.writeFileSync(path.join(root, 'agent/mesh/settings.yaml'), JSON.stringify({ bridge: { enabled: true, routes: [{ routeId: 'route', peerInstanceId: 'b'.repeat(32), remoteRoute: 'remote', localTarget: target, remoteTarget: target, mode: 'store' }] } }));
  for (let i = 0; i < count; i++) putMessage(path.join(root, 'agent'), { id: `in-seed-${i}`, runId: 'host-bridge', from: 'host', to: 'host', content: JSON.stringify({ local: { sessionId: 'host' }, target: total ? bridgeTarget({ ...target, nodeId: `seed-${Math.floor(i / 64)}` }) : target }), createdAt: i });
  await manager.shutdown(); return target;
}

test('bridge review B1 two OS processes: aged lock + actual SIGSTOP/CONT never steals ifAbsent reservation', async () => fixture(async (root, launch) => {
  const a = launch('A', { mode: 'lock', barrier: 'ifAbsent' }); await a.paused();
  const lock = path.join(root, '.pi/mesh/messages/lock-test/.recipient-686f7374.lock');
  // Controlled mtime simulates >60s age; the owner really is OS-paused, not a timer stub.
  const age = new Date(Date.now() - 61000); fs.utimesSync(lock, age, age);
  const b = launch('B', { mode: 'lock' }); const rb = await b.done;
  a.resume(); const ra = await a.done;
  assert.equal(ra.hits, 1); assert.notEqual(ra.pid, rb.pid); assert.equal(rb.outcome, 'not-stored', JSON.stringify(rb)); assert.match(rb.error, /busy/);
  assert.equal(ra.outcome, 'stored'); assert.equal(messages(root, 'lock-test')[0]!.content, 'A');
}));

test('bridge review B1 release checks actual lock identity, retaining a replacement inode', async () => fixture(async (root, launch) => {
  const a = launch('A', { mode: 'lock', barrier: 'ifAbsent' }); await a.paused();
  const lock = path.join(root, '.pi/mesh/messages/lock-test/.recipient-686f7374.lock');
  // Explicit external replacement tests release fencing, NOT supported automatic recovery.
  fs.renameSync(lock, `${lock}.old`); fs.writeFileSync(lock, 'replacement', { flag: 'wx' });
  const b = launch('B', { mode: 'lock' }); await b.done; a.resume(); await a.done;
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement');
}));

for (const total of [false, true]) test(`bridge review B2 two OS processes mixed in/out real check-write window ${total ? '256 total' : '64 target'}`, async () => fixture(async (root, launch) => {
  const cap = total ? 256 : 64, target = await setup(root, cap - 1, total);
  const a = launch('A', { target, mode: 'bridge', messageId: 'quota-a', barrier: 'before-lock' });
  const b = launch('B', { target, mode: 'bridge', direction: 'outgoing', barrier: 'before-lock' });
  await Promise.all([a.paused(), b.paused()]); a.resume(); const ra = await a.done; b.resume(); const rb = await b.done;
  assert.equal(ra.hits, 1); assert.equal(rb.hits, 1); assert.notEqual(ra.pid, rb.pid);
  const rows = messages(path.join(root, 'agent'), 'host-bridge').filter(m => /^(in-|out-)/.test(m.id) && !m.id.endsWith('-outcome'));
  assert.equal(rows.length, cap, JSON.stringify({ ra, rb })); assert.equal(rb.sends, 0);
  for (const row of rows) ackMessage(path.join(root, 'agent'), 'host-bridge', row.id, 'host');
  const restarted = await launch('restart', { target, mode: 'bridge', messageId: 'restart' }).done;
  assert.equal(restarted.claimed, false, 'ack and OS restart do not replenish');
}));

test('bridge review B3 native canonical pre-rename failure is formally discoverable and separate from later success', async () => fixture(async (root, launch) => {
  const target = await setup(root);
  const failed = await launch('failed', { target, mode: 'bridge', fault: 'pre-rename' }).done;
  const succeeded = await launch('success', { target, mode: 'bridge' }).done;
  assert.equal(failed.hits, 1); assert.equal(failed.canonical.length, 0, 'non-owner must not reserve fixed outcome');
  assert.equal(failed.inbox.count, 1, 'orphan failure must appear in formal inbox');
  assert.equal(failed.status.failureCount, 1);
  const failure = failed.inbox.entries[0]; assert.match(failure.id, /^failure-/);
  assert.equal(succeeded.selected.count, 3, 'base ID query includes distinct failure history + canonical pair');
  const outcome = succeeded.canonical.find((m: any) => m.id.endsWith('-outcome'));
  assert.equal(JSON.parse(outcome.content).admission.outcome, 'stored');
}));

test('bridge review B3 two OS processes: lock loser records independent failure before canonical winner outcome', async () => fixture(async (root, launch) => {
  const target = await setup(root); const a = launch('winner', { target, mode: 'bridge', barrier: 'ifAbsent' }); await a.paused();
  const failed = await launch('loser', { target, mode: 'bridge' }).done;
  a.resume(); const success = await a.done;
  assert.equal(success.hits, 1); assert.equal(failed.canonical.length, 0); assert.equal(failed.inbox.count, 1);
  assert.equal(success.selected.count, 3);
  assert.equal(JSON.parse(success.canonical.find((m: any) => m.id.endsWith('-outcome')).content).admission.outcome, 'stored');
}));

for (const unknown of [false, true]) test(`bridge review B3 native post-rename ${unknown ? 'unknown' : 'visible'} retained across OS restart, disabled and no RPC`, async () => fixture(async (root, launch) => {
  const target = await setup(root);
  const written = await launch('fault', { target, mode: 'bridge', fault: unknown ? 'post-unknown' : 'post-visible', inspectDisabled: true }).done;
  const restarted = await launch('restart', { target, mode: 'bridge', direction: 'inspect', inspectDisabled: true }).done;
  assert.equal(written.hits, 1); assert.equal(written.unreadable, 0);
  assert.equal(written.mailbox.length, 0); assert.equal(restarted.mailbox.length, 0);
  assert.equal(written.status.enabled, false); assert.equal(restarted.status.local, null);
  assert.equal(restarted.selected.count, 2);
  const evidence = restarted.selected.entries.map((m: any) => JSON.parse(m.content)).find((m: any) => m.admission);
  assert.equal(evidence.admission.outcome, unknown ? 'unknown' : 'stored-visible');
  assert.equal(restarted.status.failureCount, unknown ? 1 : 0);
  assert.equal(restarted.canonical.filter((m: any) => m.id.endsWith('-outcome')).length, unknown ? 0 : 1);
}));

test('bridge review B2 two OS processes: duplicate discovered under lock consumes neither persistent nor adapter quota', async () => fixture(async (root, launch) => {
  const target = await setup(root);
  const a = launch('first', { mode: 'bridge', target, barrier: 'before-lock' });
  const b = launch('duplicate', { mode: 'bridge', target, barrier: 'before-lock' });
  await Promise.all([a.paused(), b.paused()]); a.resume(); const first = await a.done; b.resume(); const duplicate = await b.done;
  assert.equal(first.status.totalUsed, 1); assert.equal(duplicate.status.totalUsed, 0);
  assert.equal(duplicate.status.evidenceCount, 1); assert.equal(duplicate.status.failureCount, 0);
  assert.equal(duplicate.mailbox.length, 1); assert.equal(duplicate.mailbox[0].content, 'body-first');
}));

for (const mode of ['host', 'child', 'canonical', 'mailbox']) for (const releaseFault of ['fstat', 'lstat', 'unlink', 'close']) test(`bridge second S1 two OS processes ${mode} ACK before native release ${releaseFault}`, async () => fixture(async (root, launch) => {
  const target = await setup(root);
  if (mode === 'child') {
    const file = path.join(root, '.pi/mesh/runs', `${target.kind === 'mesh' && target.runId}.json`), run = JSON.parse(fs.readFileSync(file, 'utf8'));
    run.status = 'running'; run.nodes[0].status = 'running'; run.nodes.push({ ...run.nodes[0], id: 'b', status: 'queued' }); fs.writeFileSync(file, JSON.stringify(run));
  }
  const a = launch('writer', { target, mode: mode === 'canonical' || mode === 'mailbox' ? 'bridge' : mode, barrier: 'release', releaseFault, releaseMailbox: mode === 'mailbox' }); await a.paused();
  const b = await launch('acker', { mode: 'ack', ackMarker: path.join(root, 'writer.ack-file') }).done;
  assert.equal(b.acknowledged, true); a.resume(); const result = await a.done;
  assert.notEqual(result.pid, b.pid); assert.equal(result.hits, 1); assert.equal(result.releaseHits, 1);
  const file = fs.readFileSync(path.join(root, 'writer.ack-file'), 'utf8'); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), b.row, 'original ID/body/actual ACK must remain exact');
  console.log('BRIDGE_SECOND_RELEASE', JSON.stringify({ mode, releaseFault, writerPid: result.pid, ackPid: b.pid, primaryHits: result.releaseHits, barrierHits: result.hits, ack: b.row, receipts: result.details?.receipts, selected: result.selected }));
  if (mode === 'host' || mode === 'child') {
    assert.equal(result.details.receipts[0].id, b.row.id); assert.notEqual(result.details.receipts[0].outcome, 'not-stored');
    assert.match(result.content[0].text, /inspect unknown IDs/);
  } else {
    const evidence = result.selected.entries.map((m: any) => JSON.parse(m.content)).find((v: any) => v.admission);
    assert.notEqual((mode === 'canonical' ? evidence.admission : evidence.mailbox).outcome, 'not-stored');
    assert.equal(result.mailbox.length, mode === 'canonical' ? 0 : 1);
  }
}));

test('bridge second S1 under-lock duplicate survives native release fault without quota or outcome', async () => fixture(async (root, launch) => {
  const target = await setup(root);
  const a = launch('first', { mode: 'bridge', target, barrier: 'before-lock' });
  const b = launch('duplicate', { mode: 'bridge', target, barrier: 'before-lock', releaseFault: 'fstat' });
  await Promise.all([a.paused(), b.paused()]); a.resume(); const first = await a.done; b.resume(); const duplicate = await b.done;
  assert.equal(duplicate.releaseHits, 1); assert.equal(duplicate.status.totalUsed, 0); assert.equal(duplicate.status.failureCount, 0);
  assert.deepEqual(duplicate.canonical, first.canonical); assert.deepEqual(duplicate.mailbox, first.mailbox);
}));
