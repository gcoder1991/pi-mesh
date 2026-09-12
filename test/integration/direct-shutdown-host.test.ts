import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager, SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from '@earendil-works/pi-coding-agent';
import registerPiMesh from '../../src/extension.ts';
import { clearSessionFleetLimiters, sessionFleetLimiter } from '../../src/fleet-limiter.ts';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function hold() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function until(check: () => boolean) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('actual Direct shutdown timeout'); await sleep(10); } }

for (const mode of ['last-owner', 'same-id-owner']) test(`bridge third T2 real SDK Direct shutdown checkpoint EIO drains before ${mode} release`, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-close-'))), oldDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(path.join(agentDir, 'mesh'), { recursive: true }); process.env.PI_CODING_AGENT_DIR = agentDir;
  const closeGate = { ...hold(), entered: false, exited: false, enabled: false }, providerGate = hold(), key = `third-close-${randomUUID()}`;
  (globalThis as any)[key] = closeGate;
  const extension = path.join(root, 'close.ts');
  fs.writeFileSync(extension, `export default pi => { pi.on('session_shutdown', async () => { const gate = globalThis[${JSON.stringify(key)}]; if (!gate.enabled) return; gate.entered = true; await gate.promise; gate.exited = true; }); };`);
  fs.writeFileSync(path.join(agentDir, 'mesh/settings.yaml'), JSON.stringify({ maxConcurrentAgents: 1, childExtensions: { 'close-gate': extension } }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const calls: any[] = [], diagnostics: any[] = [], events: any[] = [], errors: any[] = [];
  modelRuntime.registerProvider('close-local', {
    name: 'Offline Direct shutdown', baseUrl: 'file://close', apiKey: 'private-fixture', api: 'openai-completions',
    models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
    streamSimple(model: any, context: any, options: any) {
      const row = { messages: structuredClone(context.messages), aborted: false, response: undefined as any }; calls.push(row);
      const stream = createAssistantMessageEventStream(); let ended = false;
      const message: any = { role: 'assistant', content: [{ type: 'text', text: 'ACTUAL_DIRECT_CLOSE' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      const abort = () => { if (ended) return; ended = true; row.aborted = true; row.response = { ...message, stopReason: 'aborted' }; stream.push({ type: 'error', reason: 'aborted', error: row.response }); stream.end(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      void providerGate.promise.then(() => { if (!ended) { ended = true; row.response = message; stream.push({ type: 'done', reason: 'stop', message }); stream.end(); } options.signal?.removeEventListener('abort', abort); });
      return stream;
    },
  });
  async function make(name: string, id: string) {
    const cwd = path.join(root, name); fs.mkdirSync(path.join(cwd, '.pi/agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi/agents/local.md'), `---\ndescription: Actual SDK Direct\nmodel: close-local/test\ntools: read\n${name === 'A' ? 'extensions: close-gate\n' : ''}persist_session: true\n---\nReturn local result only.\n`);
    const file = path.join(cwd, 'host.jsonl'); fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }) + '\n');
    const factory = async ({ cwd, sessionManager, sessionStartEvent }: any) => {
      const observe = (pi: any) => {
        pi.events.on('subagents:diagnostic', (row: any) => diagnostics.push({ host: name, ...row }));
        for (const topic of ['subagents:stopped', 'subagents:failed', 'subagents:completed']) pi.events.on(topic, (row: any) => events.push({ host: name, topic, ...row }));
      };
      const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: true }), resourceLoaderOptions: { noExtensions: true, extensionFactories: [observe, registerPiMesh], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true } });
      return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModel('close-local', 'test'), tools: [] }), services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.open(file) });
    await runtime.session.bindExtensions({ mode: 'rpc', onError: (error: any) => errors.push(error) }); runtime.session.setActiveToolsByName([]);
    const tool = (name: string, args: any, signal?: AbortSignal) => { const session = runtime.session; return session.extensionRunner!.getAllRegisteredTools().find(t => t.definition.name === name)!.definition.execute(randomUUID(), args, signal, undefined, session.extensionRunner!.createContext()); };
    const registry = path.join(cwd, '.pi/mesh/subagents', `${createHash('sha256').update(id).digest('hex').slice(0, 16)}.json`);
    return { runtime, tool, registry };
  }
  const id = randomUUID(), otherId = randomUUID();
  const hosts: Awaited<ReturnType<typeof make>>[] = []; const pending: Promise<any>[] = [];
  const rename = fs.renameSync; let hits = 0, armed = false;
  try {
    const a = await make('A', id); hosts.push(a);
    const b = mode === 'same-id-owner' ? await make('B', id) : undefined; if (b) hosts.push(b);
    const c = await make('C', otherId); hosts.push(c);
    const pool = sessionFleetLimiter(id, 1), otherPool = sessionFleetLimiter(otherId, 1);
    const spawn = (host: typeof a, prompt: string, signal?: AbortSignal) => host.tool('Agent', { prompt, description: prompt, subagent_type: 'local', run_in_background: true }, signal) as Promise<any>;
    const first = await spawn(a, 'A-live'); await until(() => { assert.equal(events.some(row => row.id === first.details.agentId), false, JSON.stringify({ events, diagnostics, errors, registry: fs.existsSync(a.registry) ? JSON.parse(fs.readFileSync(a.registry, 'utf8')) : null })); return calls.length === 1; });
    const waiter = await spawn(a, 'A-waiter'); await until(() => pool.queued === 1);
    // A prior explicit user/unknown cancel lock must survive the final registry write.
    const controller = new AbortController();
    const lockedRun = a.tool('Agent', { prompt: 'A-locked', description: 'locked', subagent_type: 'local' }, controller.signal); pending.push(lockedRun);
    await until(() => pool.queued === 2); controller.abort(); const locked: any = await lockedRun;
    const other = c.tool('Agent', { prompt: 'C-live', description: 'other Host', subagent_type: 'local' }); pending.push(other); await until(() => calls.length === 2);
    const fault = Object.assign(new Error('first Direct abort checkpoint native EIO'), { code: 'EIO', syscall: 'rename', path: a.registry });
    fs.renameSync = ((from: any, to: any) => {
      if (armed && !hits && String(to) === a.registry) {
        const rows = JSON.parse(fs.readFileSync(from, 'utf8'));
        assert.equal(rows.find((r: any) => r.id === first.details.agentId).abortSource, 'shutdown');
        assert.equal(rows.find((r: any) => r.id === first.details.agentId).status, 'stopped');
        hits++; throw fault;
      }
      return rename(from, to);
    }) as any; syncBuiltinESMExports(); armed = true; closeGate.enabled = true;
    let closed = false; const close = a.runtime.dispose().then(() => { closed = true; }); pending.push(close);
    await until(() => closeGate.entered); await sleep(50);
    assert.equal(hits, 1); assert.equal(closed, false, 'Host dispose cannot resolve before actual child session_shutdown gate exits');
    assert.equal(closeGate.exited, false); assert.equal(pool.active, 1); assert.equal(pool.queued, 0, 'all records, not only the faulting first record, cancelled');
    clearSessionFleetLimiters(); assert.equal(sessionFleetLimiter(id, 1), pool, 'no owner release before real drain');
    const during = JSON.parse(fs.readFileSync(a.registry, 'utf8'));
    for (const target of [first, waiter]) { const row = during.find((r: any) => r.id === target.details.agentId); assert.equal(row.status, 'stopped'); assert.equal(row.abortSource, 'shutdown'); }
    assert.equal(calls.length, 2); assert.equal(calls[0].aborted, true); assert.equal(calls[1].aborted, false);
    assert.equal(sessionFleetLimiter(otherId, 1), otherPool); assert.equal(otherPool.active, 1);
    closeGate.resolve(); await close;
    assert.equal(closeGate.exited, true); assert.equal(pool.active, 0); assert.equal(pool.queued, 0); assert.equal(calls.length, 2, 'no successor provider after shutdown');
    const retained = JSON.parse(fs.readFileSync(a.registry, 'utf8'));
    const lock = retained.find((r: any) => r.id === locked.details.agentId); assert.equal(lock.autoContinueBlocked, true); assert.equal(lock.abortSource, 'unknown'); assert.equal(lock.abortVersion, 1);
    for (const target of [first, waiter]) assert.equal(retained.find((r: any) => r.id === target.details.agentId).status, 'stopped');
    const finished = retained.find((r: any) => r.id === first.details.agentId);
    const usage = calls[0].response.usage;
    for (const saved of [finished.result.usage, finished.cumulativeUsage, finished.unclaimedUsage]) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) assert.equal(saved[field], usage[field], 'actual aborted provider usage remains unclaimed');
      assert.equal(saved.cost, usage.cost.total); assert.equal(saved.turns, 1);
    }
    const diagnostic = diagnostics.find(row => row.host === 'A' && row.id === first.details.agentId && /Shutdown cancellation/.test(row.message)); assert.ok(diagnostic, 'checkpoint error survives final state and Host manager disposal');
    let cause = diagnostic.cause; while (cause?.cause) cause = cause.cause; assert.equal(cause, fault); assert.equal(cause.code, 'EIO');
    assert.ok(events.some(row => row.id === waiter.details.agentId && row.topic === 'subagents:stopped'));
    const diagnosticCount = diagnostics.length; await a.runtime.dispose(); assert.equal(diagnostics.length, diagnosticCount);
    if (b) {
      clearSessionFleetLimiters(); assert.equal(sessionFleetLimiter(id, 1), pool, 'same SessionID idle owner retained');
      providerGate.resolve(); const completed: any = await b.tool('Agent', { prompt: 'B-after-A-close', description: 'B', subagent_type: 'local' }); assert.equal(completed.details.status, 'completed');
      assert.equal(sessionFleetLimiter(id, 1), pool); await b.runtime.dispose();
    }
    assert.notEqual(sessionFleetLimiter(id, 1), pool, 'last owner retires drained pool despite checkpoint error');
    assert.equal(sessionFleetLimiter(otherId, 1), otherPool); providerGate.resolve();
    const otherResult: any = await other; assert.equal(otherResult.details.status, 'completed'); assert.deepEqual(otherResult.usage, calls[1].response.usage);
    await c.runtime.dispose(); assert.notEqual(sessionFleetLimiter(otherId, 1), otherPool); assert.deepEqual(errors, []);
    assert.equal(calls.length, b ? 3 : 2, 'no cancelled record or Host notification successor');
    console.log('BRIDGE_THIRD_SHUTDOWN', JSON.stringify({ mode, hits, recordId: first.details.agentId, waiterId: waiter.details.agentId, diagnostics: diagnostics.map(({ cause, ...row }) => ({ ...row, cause: String(cause), nativeCode: (() => { let native = cause; while (native?.cause) native = native.cause; return native?.code; })() })), providerCalls: calls.length, calls, usage: finished.unclaimedUsage, drained: true, lastOwnerRetired: true }));
  } finally {
    fs.renameSync = rename; syncBuiltinESMExports(); closeGate.resolve(); providerGate.resolve();
    await Promise.allSettled(pending); for (const host of hosts) await host.runtime.dispose();
    delete (globalThis as any)[key]; if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
