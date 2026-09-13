import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager, SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from '@earendil-works/pi-coding-agent';
import registerPiMesh from '../../src/extension.ts';
import { clearSessionFleetLimiters, sessionFleetLimiter } from '../../src/fleet-limiter.ts';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function hold() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function until(check: () => boolean) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('actual Fleet lifecycle timeout'); await sleep(10); } }

for (const mode of ['close', 'newSession', 'switchSession', 'same-id-live', 'same-id-idle']) test(`bridge second S5 real SDK Host ${mode} preserves other Manager owners and actual Fleet waiter`, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-host-'))), oldDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(path.join(agentDir, 'mesh'), { recursive: true }); process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.writeFileSync(path.join(agentDir, 'mesh/settings.yaml'), JSON.stringify({ maxConcurrentAgents: 1 }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  let gate = hold(); const calls: any[] = [], errors: any[] = [], pending: Promise<any>[] = [];
  modelRuntime.registerProvider('fleet-local', {
    name: 'Offline Fleet lifecycle', baseUrl: 'file://fleet', apiKey: 'private-fixture', api: 'openai-completions',
    models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
    streamSimple(model: any, context: any, options: any) {
      const row = { messages: structuredClone(context.messages), aborted: false }; calls.push(row);
      const wait = gate.promise, stream = createAssistantMessageEventStream(); let ended = false;
      const message: any = { role: 'assistant', content: [{ type: 'text', text: 'FLEET_ACTUAL_COMPLETED' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      const abort = () => { if (ended) return; ended = true; row.aborted = true; stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } }); stream.end(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      void wait.then(() => { if (!ended) { ended = true; stream.push({ type: 'done', reason: 'stop', message }); stream.end(); } options.signal?.removeEventListener('abort', abort); });
      return stream;
    },
  });
  const idB = randomUUID(), idA = mode.startsWith('same-id') ? idB : randomUUID();
  const header = (file: string, cwd: string, id: string) => fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }) + '\n');
  async function make(name: string, id: string) {
    const cwd = path.join(root, name); fs.mkdirSync(path.join(cwd, '.pi/agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi/agents/local.md'), '---\ndescription: Actual local SDK child\nmodel: fleet-local/test\ntools: read\n---\nReturn local result.\n');
    const file = path.join(cwd, 'host.jsonl'); header(file, cwd, id);
    const factory = async ({ cwd, sessionManager, sessionStartEvent }: any) => {
      const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: true }), resourceLoaderOptions: { noExtensions: true, extensionFactories: [registerPiMesh], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true } });
      return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModel('fleet-local', 'test'), tools: [] }), services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.open(file) });
    const bind = async (session: any) => { await session.bindExtensions({ mode: 'rpc', onError: (e: any) => errors.push(e) }); session.setActiveToolsByName([]); };
    await bind(runtime.session); runtime.setRebindSession(bind);
    const tool = (name: string, args: any) => { const session = runtime.session; return session.extensionRunner!.getAllRegisteredTools().find(t => t.definition.name === name)!.definition.execute(randomUUID(), args, undefined, undefined, session.extensionRunner!.createContext()); };
    return { runtime, cwd, tool };
  }
  let a: Awaited<ReturnType<typeof make>> | undefined, b: Awaited<ReturnType<typeof make>> | undefined;
  try {
    b = await make('B', idB); a = await make('A', idA);
    const oldA = sessionFleetLimiter(idA, 1);
    const limiter = sessionFleetLimiter(idB, 1); assert.equal(limiter.active, 0);
    if (mode !== 'same-id-idle') {
      pending.push(b.tool('mesh', { action: 'run', async: false, tasks: [{ id: 'node', agent: 'local', task: 'Hold actual Mesh execution' }] }));
      await until(() => calls.length === 1);
      pending.push(b.tool('Agent', { prompt: 'Actual Direct waiter', description: 'waiter', subagent_type: 'local' }));
      await until(() => limiter.queued === 1); assert.equal(limiter.active, 1);
    }
    if (mode === 'newSession') assert.equal((await a.runtime.newSession()).cancelled, false);
    else if (mode === 'switchSession') { const file = path.join(a.cwd, 'replacement.jsonl'); header(file, a.cwd, randomUUID()); assert.equal((await a.runtime.switchSession(file)).cancelled, false); }
    else await a.runtime.dispose();
    assert.equal(sessionFleetLimiter(idB, 1), limiter, 'A cannot orphan B\'s registered pool, even idle/same sessionId');
    assert.equal(limiter.active, mode === 'same-id-idle' ? 0 : 1); assert.equal(limiter.queued, mode === 'same-id-idle' ? 0 : 1);
    assert.equal(calls.length, mode === 'same-id-idle' ? 0 : 1); assert.equal(calls.some(c => c.aborted), false);
    if (mode !== 'same-id-idle') {
      const list: any = await b.tool('mesh', { action: 'list' }); const status: any = await b.tool('mesh', { action: 'status', runId: list.details.runs[0].id }); assert.equal(status.details.run.nodes[0].status, 'running');
      gate.resolve(); const [mesh, direct] = await Promise.all(pending); assert.equal(mesh.details.run.status, 'succeeded'); assert.equal(direct.details.status, 'completed'); assert.equal(calls.length, 2);
    }
    if (mode === 'newSession' || mode === 'switchSession') {
      assert.notEqual(sessionFleetLimiter(idA, 1), oldA, 'A old Managers retired their own pool');
      const newId = a.runtime.session.sessionManager.getSessionId(); assert.notEqual(newId, idA);
      const newPool = sessionFleetLimiter(newId, 1);
      // Public explicit cleanup is an ownership probe, not a synthetic execution.
      clearSessionFleetLimiters(); assert.equal(sessionFleetLimiter(newId, 1), newPool, 'new A idle Managers already retain their pool');
      gate = hold(); const beforeA = calls.length;
      const newMesh = a.tool('mesh', { action: 'run', async: false, tasks: [{ id: 'new-a', agent: 'local', task: 'New A actual Mesh owner' }] }); pending.push(newMesh);
      await until(() => calls.length === beforeA + 1);
      const newDirect = a.tool('Agent', { prompt: 'New A actual Direct waiter', description: 'new A', subagent_type: 'local' }); pending.push(newDirect);
      await until(() => newPool.queued === 1); assert.equal(newPool.active, 1); assert.equal(sessionFleetLimiter(newId, 1), newPool);
      gate.resolve(); const [meshA, directA]: any[] = await Promise.all([newMesh, newDirect]);
      assert.equal(meshA.details.run.status, 'succeeded'); assert.equal(directA.details.status, 'completed'); assert.equal(calls.length, beforeA + 2);
      assert.equal(newPool.active, 0); assert.equal(newPool.queued, 0); clearSessionFleetLimiters(); assert.equal(sessionFleetLimiter(newId, 1), newPool);
      await a.runtime.dispose(); assert.notEqual(sessionFleetLimiter(newId, 1), newPool, 'new A last dispose retires its pool');
      assert.equal(sessionFleetLimiter(idB, 1), limiter, 'B remains owned during the new A entire lifecycle');
    }
    // Existing B Direct and Mesh managers still share one pool in the reverse order.
    gate = hold(); const before = calls.length;
    pending.push(b.tool('Agent', { prompt: 'Existing Direct owner', description: 'second', subagent_type: 'local' }));
    await until(() => calls.length === before + 1);
    pending.push(b.tool('mesh', { action: 'run', async: false, tasks: [{ id: 'later', agent: 'local', task: 'Existing Mesh owner waiter' }] }));
    await until(() => limiter.queued === 1); assert.equal(limiter.active, 1); assert.equal(sessionFleetLimiter(idB, 1), limiter);
    gate.resolve(); await Promise.all(pending); assert.equal(calls.length, before + 2); assert.equal(limiter.active, 0); assert.equal(limiter.queued, 0);
    assert.equal(sessionFleetLimiter(idB, 1), limiter, 'idle Managers are still owners');
    await b.runtime.dispose(); assert.notEqual(sessionFleetLimiter(idB, 1), limiter, 'only after all B owners drain can the pool be retired');
    assert.deepEqual(errors, []); console.log('FLEET_HOST_ACTUAL', JSON.stringify({ mode, providerCalls: calls.length, calls, actualWaiter: true, preservedIdentity: true }));
  } finally { gate.resolve(); await Promise.allSettled(pending); await a?.runtime.dispose(); await b?.runtime.dispose(); if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; fs.rmSync(root, { recursive: true, force: true }); }
});
