// Actual OS worker. Faults intercept native FS boundaries, never a successful persist wrapper.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { MeshManager } from '../../src/manager.ts';
import { defaultMeshSettings } from '../../src/settings.ts';
import { putMessage, messages, ackMessage } from '../../src/store.ts';
import { registerHostBridge, incomingBridgeId, bridgeMessages } from '../../src/host-bridge.ts';
import { extensionHarness, context } from './extension-harness.ts';
import { createMeshControlTool } from '../../src/control-extension.ts';
import { failDirectorySync } from './atomic-fault.ts';
import { BRIDGE_PREFIX, RECEIVED, RPC_INFO, RPC_SEND } from '../../src/bridge-wire.ts';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root, name, mode, direction = 'incoming', barrier } = config;
process.chdir(root); process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
const marker = suffix => path.join(root, `${name}.${suffix}`);
let hits = 0;
function pause() { hits++; fs.writeFileSync(marker('paused'), String(process.pid)); process.kill(process.pid, 'SIGSTOP'); }
const native = { open: fs.openSync, lstat: fs.lstatSync, rename: fs.renameSync };
const id = mode === 'lock' ? 'canonical' : incomingBridgeId('b'.repeat(32), config.messageId ?? 'same');
if (barrier === 'before-lock') fs.openSync = function(file, ...args) { if (!hits && String(file).endsWith('.recipient-686f7374.lock')) pause(); return native.open(file, ...args); };
if (barrier === 'ifAbsent') fs.lstatSync = function(file, ...args) { try { return native.lstat(file, ...args); } catch (e) { if (!hits && e.code === 'ENOENT' && String(file).endsWith(`/${id}.json`)) pause(); throw e; } };
if (config.fault === 'pre-rename') fs.renameSync = function(from, to) { if (!hits && String(to).endsWith(`/${id}.json`)) { hits++; throw new Error('native canonical pre-rename fault'); } return native.rename(from, to); };
let unreadable = 0, postFault;
if (config.fault?.startsWith('post-')) {
  const read = fs.readFileSync;
  postFault = failDirectorySync(file => { if (!file.endsWith(`/${id}.json`)) return false; if (config.fault === 'post-unknown') unreadable = 2; return true; });
  fs.readFileSync = function(file, ...args) { if (unreadable && String(file).endsWith(`/${id}.json`)) { unreadable--; throw new Error('native verification read fault'); } return read(file, ...args); };
}
syncBuiltinESMExports();
let releaseHits = 0, ackFile;
if (config.releaseFault) {
  const open = fs.openSync, fstat = fs.fstatSync, lstat = fs.lstatSync, unlink = fs.unlinkSync, close = fs.closeSync;
  let lockFd, lockPath, paused = false;
  fs.openSync = function(file, ...args) {
    const fd = open(file, ...args);
    const suffix = config.releaseMailbox || mode === 'host' ? '.recipient-61.lock' : mode === 'child' ? '.recipient-62.lock' : '.recipient-686f7374.lock';
    if (String(file).endsWith(suffix)) { lockFd = fd; lockPath = String(file); }
    return fd;
  };
  function fault(step) { if (!releaseHits && config.releaseFault === step) { releaseHits++; throw Object.assign(new Error(`native release ${step} EIO`), { code: 'EIO' }); } }
  fs.fstatSync = function(fd, ...args) {
    if (fd === lockFd) {
      if (barrier === 'release' && !paused) {
        paused = true;
        const row = messages(config.releaseMailbox || mode === 'host' || mode === 'child' ? root : path.join(root, 'agent'), config.target.runId && (config.releaseMailbox || mode === 'host' || mode === 'child') ? config.target.runId : 'host-bridge').find(m => !m.id.endsWith('-outcome'));
        ackFile = path.join(path.dirname(lockPath), `${row.id}.json`);
        fs.writeFileSync(marker('ack-file'), ackFile); pause();
      }
      fault('fstat');
    }
    return fstat(fd, ...args);
  };
  fs.lstatSync = function(file, ...args) { if (String(file) === lockPath) fault('lstat'); return lstat(file, ...args); };
  fs.unlinkSync = function(file) { if (String(file) === lockPath) fault('unlink'); return unlink(file); };
  fs.closeSync = function(fd) { if (fd === lockFd) { try { fault('close'); } finally { lockFd = undefined; } } return close(fd); };
  syncBuiltinESMExports();
}
let result;
if (mode === 'ack') {
  const file = fs.readFileSync(config.ackMarker, 'utf8'), row = JSON.parse(fs.readFileSync(file, 'utf8'));
  const spoolRoot = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(file)))));
  result = { acknowledged: ackMessage(spoolRoot, row.runId, row.id, row.to), row: JSON.parse(fs.readFileSync(file, 'utf8')) };
} else if (mode === 'host' || mode === 'child') {
  if (mode === 'host') {
    const h = extensionHarness(), ctx = context(root); ctx.sessionManager.getSessionId = () => 'host';
    for (const cb of h.handlers.get('pi:session_start') ?? []) await cb({}, ctx);
    try { result = await h.tools.get('mesh').execute('send', { action: 'message_send', runId: config.target.runId, to: 'a', content: 'host release body' }, undefined, undefined, ctx); }
    finally { await h.shutdown(); }
  } else result = await createMeshControlTool(root, config.target.runId, 'a', 0).execute('send', { action: 'send', to: 'b', content: 'child release body' });
  result = { ...result, mailbox: messages(root, config.target.runId) };
} else if (mode === 'lock') {
  try { result = putMessage(root, { id, runId: 'lock-test', from: name, to: 'host', content: name, createdAt: Date.now() }, { payloadMaxBytes: 65536, recipientUnreadMaxBytes: 1e6, ifAbsent: true }); }
  catch (e) { result = { outcome: e.outcome, error: String(e) }; }
} else {
  const listeners = new Map(); const hooks = new Map();
  const bus = { on(topic, cb) { const set = listeners.get(topic) ?? new Set(); set.add(cb); listeners.set(topic, set); return () => set.delete(cb); }, emit(topic, q) { for (const cb of listeners.get(topic) ?? []) cb(q); } };
  const pi = { events: bus, on(topic, cb) { const list = hooks.get(topic) ?? []; list.push(cb); hooks.set(topic, list); } };
  const local = { sessionId: 'host', instanceId: 'a'.repeat(32) };
  const ctx = { cwd: root, sessionManager: { getSessionId: () => local.sessionId }, isProjectTrusted: () => true };
  const manager = new MeshManager(() => undefined, defaultMeshSettings, undefined, undefined, 'host', true); manager.recover(root);
  const target = config.target;
  bus.on(RPC_INFO, q => bus.emit(`${RPC_INFO}:reply:${q.requestId}`, { version: 1, requestId: q.requestId, ok: true, local, capability: 'cancel-safe-queue-v1' }));
  let sends = 0;
  bus.on(RPC_SEND, q => { sends++; bus.emit(`${RPC_SEND}:reply:${q.requestId}`, { version: 1, requestId: q.requestId, local, ok: true, messageId: q.messageId, target: { instanceId: q.remoteInstanceId }, receipt: { status: 'accepted' } }); });
  const adapter = registerHostBridge(pi, () => manager, () => undefined);
  for (const cb of hooks.get('session_start') ?? []) await cb({}, ctx);
  if (direction === 'incoming') {
    const envelope = { version: 1, origin: 'b'.repeat(32), correlationId: name, expiresAt: Date.now() + 30000, hops: 0, budget: 4, payload: { version: 1, route: 'route', target, content: `body-${name}`, claim: 'host-transcribed-not-user' } };
    let claimed = false;
    bus.emit(RECEIVED, Object.freeze({ version: 1, local, source: Object.freeze({ id: 'peer', instanceId: 'b'.repeat(32) }), messageId: config.messageId ?? 'same', sentAt: Date.now(), text: BRIDGE_PREFIX + JSON.stringify(envelope), bridge: envelope, canHandle: true, reply() { if (claimed) return false; claimed = true; return true; } }));
    result = { claimed };
  } else if (direction === 'inspect') { result = {}; } else { result = await adapter.execute('bridge_send', { routeId: 'route', content: `body-${name}` }, undefined, ctx); }
  if (config.inspectDisabled) { const file = path.join(root, 'agent/mesh/settings.yaml'); const settings = JSON.parse(fs.readFileSync(file, 'utf8')); settings.bridge.enabled = false; fs.writeFileSync(file, JSON.stringify(settings)); listeners.delete(RPC_INFO); }
  result = { ...result, sends, inbox: await adapter.execute('bridge_inbox', {}, undefined, ctx), selected: await adapter.execute('bridge_inbox', { messageId: id }, undefined, ctx), status: await adapter.execute('bridge_status', {}, undefined, ctx), canonical: bridgeMessages().filter(m => m.id === id || m.id === `${id}-outcome`), mailbox: messages(root, target.runId) };
  for (const cb of hooks.get('session_shutdown') ?? []) await cb({}, ctx);
  await manager.shutdown();
}
fs.writeFileSync(marker('result'), JSON.stringify({ ...result, hits: hits + (postFault?.hits ?? 0), releaseHits, unreadable, pid: process.pid }, null, 2));
