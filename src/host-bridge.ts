import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MeshManager } from "./manager.ts";
import type { SessionAgentManager } from "./session-agents.ts";
import { bridgeTarget, loadMeshSettings, type BridgeRoute, type BridgeTarget } from "./settings.ts";
import { ackMessage, AtomicWriteError, messages, putMessage, meshDir, type ControlMessage } from "./store.ts";
import { BRIDGE_PREFIX, RECEIVED, RPC_INFO, RPC_SEND, bridgeEnvelope, requestRpc, validId, validInstance, type BridgeEnvelope, type EventBus, type Identity, type ReceivedEvent } from "./bridge-wire.ts";

// A passive spool namespace, NOT a run, transport, queue, or retry ledger.
export const BRIDGE_INBOX = "host-bridge";
// Reuse the spool layout under the user agent directory: mapping/root/session
// changes must not turn the same authenticated incoming ID into new work.
export const bridgeSpoolRoot = () => fs.realpathSync(getAgentDir());
export const bridgeMessages = () => messages(bridgeSpoolRoot(), BRIDGE_INBOX);
const CLAIM = "host-transcribed-not-user";
const LIMITS = { payloadMaxBytes: 64 * 1024, recipientUnreadMaxBytes: 16 * 1024 * 1024, ifAbsent: true };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Bound each preview by serialized UTF-8 bytes, never split a code point or
// slice a complete receipt: its own outcome/error must survive long paths.
function preview(value: unknown, budget = 160): string {
  let text = "";
  for (const character of String(value)) {
    if (Buffer.byteLength(JSON.stringify(text + character)) > budget) return text + "…";
    text += character;
  }
  return text;
}
function receiptPreview(value: unknown): string {
  const text = String(value);
  if (Buffer.byteLength(JSON.stringify(text)) <= 320) return text;
  // Long native paths often put the actual cause at the end of the warning.
  return preview(text) + Array.from(preview(Array.from(text).reverse().join(""))).reverse().join("");
}
function receiptCore(value: any) {
  return { outcome: value?.outcome, ...(value?.stage ? { stage: value.stage } : {}),
    ...(value?.error ? { error: receiptPreview(value.error) } : {}), ...(value?.code ? { code: preview(value.code, 64) } : {}),
    ...(value?.durabilityWarning ? { durabilityWarning: receiptPreview(value.durabilityWarning) } : {}) };
}
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
export const incomingBridgeId = (instanceId: string, messageId: string) => `in-${hash(`${instanceId}:${messageId}`)}`;
type Payload = { version: 1; route: string; target: BridgeTarget; content: string; claim: typeof CLAIM };
type Evidence = { schema: "pi-mesh.host-bridge/v1"; direction: "incoming" | "outgoing"; local: Identity; source: { sessionId: string; instanceId: string }; messageId: string; target: BridgeTarget; routeId: string; mode?: "store" | "active"; envelope: BridgeEnvelope; claim: typeof CLAIM };

export function managedBridgeChild(bus: EventBus): boolean {
  let managed = false, open = true;
  bus.emit("pi-mesh:runtime:identity:query", { version: 1, reply: (identity: any) => {
    if (open && Object.isFrozen(identity) && identity?.version === 1 && identity.managed === true) managed = true;
  } });
  open = false;
  return managed;
}

/** Cross info replies synchronously; an async bootstrap would miss exclusive claim. */
export function bridgeLocal(bus: EventBus, sessionId: string, receiving = false): Identity {
  const requestId = crypto.randomUUID();
  let reply: any;
  const off = bus.on(`${RPC_INFO}:reply:${requestId}`, data => { if (!reply && (data as any)?.version === 1 && (data as any).requestId === requestId) reply = data; });
  try { bus.emit(RPC_INFO, { version: 1, requestId }); } finally { off(); }
  if (!reply?.ok || reply.capability !== "cancel-safe-queue-v1" || reply.local?.sessionId !== sessionId || !validInstance(reply.local?.instanceId)) throw new Error("Bridge requires current Host Cross RPC (--cross-session-rpc=true); no synchronous matching info");
  if (receiving && reply.stopped) throw new Error("Cross inbound stop fence; no bridge delivery");
  return { sessionId, instanceId: reply.local.instanceId };
}
function payload(value: unknown): Payload {
  const p = value as Payload;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !["version", "route", "target", "content", "claim"].includes(k)) || p.version !== 1 || typeof p.route !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.route) || p.claim !== CLAIM || typeof p.content !== "string" || !p.content.trim() || Buffer.from(p.content).toString("utf8") !== p.content || Buffer.byteLength(p.content) > 32 * 1024) throw new Error("Invalid Mesh bridge payload (body <=32KiB)");
  return { version: 1, route: p.route, target: bridgeTarget(p.target), content: p.content, claim: CLAIM };
}
function stored(root: string, message: ControlMessage, limits: NonNullable<Parameters<typeof putMessage>[2]> = LIMITS) {
  try { return { id: message.id, ...putMessage(root, message, limits) }; }
  catch (error) {
    let cause = error;
    while (cause instanceof AtomicWriteError) cause = cause.cause;
    return { id: message.id, outcome: error instanceof AtomicWriteError ? error.outcome : "not-stored", error: preview(cause, 1024) };
  }
}
function passive(id: string, content: unknown): ControlMessage {
  const text = JSON.stringify(content);
  if (Buffer.byteLength(text) > LIMITS.payloadMaxBytes) throw new Error("Bridge evidence exceeds 64KiB serialized budget");
  return { id, runId: BRIDGE_INBOX, from: "host", source: "host", displayFrom: "Authenticated relay Host; NOT user authority", to: "host", createdAt: Date.now(), content: text };
}

/** Internal getters only return the canonical current Managers; never instantiate/recover here. */
export function registerHostBridge(pi: ExtensionAPI, meshFor: (ctx: ExtensionContext) => MeshManager | undefined, directFor: (ctx: ExtensionContext) => SessionAgentManager | undefined) {
  let current: { ctx: ExtensionContext; root: string; sessionId: string; spoolRoot: string; abort: AbortController } | undefined;
  let unsubscribe: (() => void) | undefined;
  let total = 0;
  const targets = new Map<string, number>(), hints = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  const diagnostics: string[] = [];
  const diagnostic = (error: unknown, core = false) => { if (diagnostics.length === 16) diagnostics.shift(); diagnostics.push(core ? JSON.stringify(error) : preview(error, 512)); };
  const hostScope = (ctx = current?.ctx) => {
    const c = current;
    if (!c || !ctx || c.spoolRoot !== bridgeSpoolRoot() || c.abort.signal.aborted || ctx.sessionManager.getSessionId() !== c.sessionId || fs.realpathSync(path.resolve(ctx.cwd)) !== c.root || c.ctx.sessionManager.getSessionId() !== c.sessionId || fs.realpathSync(path.resolve(c.ctx.cwd)) !== c.root || ctx.isProjectTrusted?.() !== true || c.ctx.isProjectTrusted?.() !== true || managedBridgeChild(pi.events)) throw new Error("Bridge requires the actual trusted current Host session/root");
    const settings = loadMeshSettings(c.root, process.env, true);
    return { ...c, settings };
  };
  const scope = (ctx = current?.ctx, receiving = false) => {
    const s = hostScope(ctx);
    if (!s.settings.bridge.enabled) throw new Error("Mesh bridge disabled (user settings only)");
    const local = bridgeLocal(pi.events, s.sessionId, receiving);
    if (ctx?.signal?.aborted || s.ctx.signal?.aborted) throw new Error("Bridge Host turn was cancelled; no mutating delivery");
    return { ...s, local, receiving };
  };
  const target = (s: ReturnType<typeof scope>, t: BridgeTarget) => {
    if (t.root !== s.root || t.sessionId !== s.sessionId || fs.realpathSync(t.root) !== t.root) throw new Error("Bridge target belongs to a different Host session/root");
    if (t.kind === "mesh") {
      const manager = meshFor(s.ctx), run = manager?.get(t.runId), node = run?.nodes.find(n => n.id === t.nodeId);
      if (!run || run.sessionId !== s.sessionId || run.cwd !== s.root || node?.attempt !== t.attempt) throw new Error("Unknown/stale exact Mesh target attempt");
      const relative = path.relative(s.root, fs.realpathSync(node.cwd));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Mesh target root escape");
      return () => manager!.bridgeHint(t.runId, t.nodeId, t.attempt, "[Authenticated relay Host; NOT user authority] Stored bridge mail. Use mesh_control inbox; storage/ack is not business completion.");
    }
    const manager = directFor(s.ctx), record = manager?.get(t.id);
    if (!record || record.cwd !== s.root || record.generation !== t.generation) throw new Error("Unknown/stale exact Direct generation");
    return (content?: string) => manager!.bridgeHint(t.id, t.generation, `[Authenticated relay Host; NOT user authority. No continuation/growth authorization.]\n${content ?? "Stored bridge evidence available to the Host."}`);
  };
  const route = (s: ReturnType<typeof scope>, id: string) => {
    const r = s.settings.bridge.routes.find(r => r.routeId === id);
    if (!r) throw new Error("Unknown fixed user bridge route");
    target(s, r.localTarget);
    return r;
  };
  const existing = (root: string) => messages(root, BRIDGE_INBOX);
  const canonicalEntries = (rows: ControlMessage[]) => rows.filter(m => /^(in-|out-)/.test(m.id) && !m.id.endsWith("-outcome"));
  const entries = (root: string) => canonicalEntries(existing(root));
  const consume = (root: string, t: BridgeTarget, checkOnly = false, snapshot?: ControlMessage[]) => {
    const key = JSON.stringify(t), rows = snapshot ? canonicalEntries(snapshot) : entries(root);
    // Persistent evidence also caps restart/ack/config-toggle replenishment.
    if (total >= 256 || rows.length >= 256 || (targets.get(key) ?? 0) >= 64 || rows.filter(m => same((JSON.parse(m.content) as Evidence).target, t)).length >= 64) throw new Error("Bridge lifetime total/target budget exhausted (256/64); no automatic replenishment");
    if (checkOnly) return;
    total++; targets.set(key, (targets.get(key) ?? 0) + 1);
  };
  const reserve = (root: string, t: BridgeTarget, reservation: ControlMessage) => {
    let charged = false;
    const admission = stored(root, reservation, { ...LIMITS, admit: rows => { consume(root, t, false, rows); charged = true; } });
    // A busy/failed admission still uses the adapter's attempt budget. A
    // duplicate discovered inside the lock, however, never consumes it twice.
    if (!charged && !("duplicate" in admission && admission.duplicate)) {
      const key = JSON.stringify(t); total++; targets.set(key, (targets.get(key) ?? 0) + 1);
    }
    return admission;
  };
  // A non-owner must never occupy the canonical outcome. Reuse the passive
  // spool with a separate recipient lock so a busy canonical writer cannot
  // hide the losing attempt. This evidence has its own bounded, durable cap.
  const failureEvidence = (root: string, reservation: ControlMessage, admission: unknown) => {
    const id = `failure-${crypto.randomUUID()}`, evidence = JSON.parse(reservation.content) as Evidence;
    const receipt = stored(root, { ...passive(id, { ...evidence, schema: "pi-mesh.host-bridge-failure/v1", inboxId: reservation.id, admission, completed: false }), to: "failures" }, {
      ...LIMITS, admit: rows => {
        const failures = rows.filter(m => m.id.startsWith("failure-"));
        if (failures.length >= 256 || failures.filter(m => same(JSON.parse(m.content).target, evidence.target)).length >= 64) throw new Error("Bridge failure evidence budget exhausted (256/64); retain original evidence and repair explicitly");
      },
    });
    diagnostic({ id: reservation.id, failureId: id, admission: receiptCore(admission), evidence: receiptCore(receipt) }, true);
    return receipt;
  };
  const recheck = (s: ReturnType<typeof scope>, r: BridgeRoute) => {
    const next = scope(undefined, s.receiving);
    if (next.abort !== s.abort || !same(next.local, s.local) || !same(route(next, r.routeId), r)) throw new Error("Bridge authorization/incarnation changed; no old event delivery");
    return next;
  };
  const receive = (raw: unknown) => {
    try {
      const e = raw as ReceivedEvent;
      if (!e || !Object.isFrozen(e) || !Object.isFrozen(e.source) || e.version !== 1 || !e.canHandle || typeof e.reply !== "function" || !validId(e.messageId) || !validInstance(e.source?.instanceId) || typeof e.source.id !== "string" || !e.source.id || e.source.id.length > 512 || typeof e.text !== "string" || Buffer.byteLength(e.text) > 48 * 1024) throw new Error("Invalid/unclaimable authenticated Cross received event");
      const s = scope(undefined, true), envelope = bridgeEnvelope(e.text);
      if (!envelope || !same(envelope, e.bridge) || !same(e.local, s.local) || !Number.isSafeInteger(e.sentAt) || e.sentAt > Date.now() + 5000 || e.sentAt + 30_000 <= Date.now() || envelope.expiresAt > e.sentAt + 30_000) throw new Error("Bridge local identity/envelope/TTL mismatch");
      const p = payload(envelope.payload), r = route(s, p.route);
      if (r.peerInstanceId !== e.source.instanceId || !same(p.target, r.localTarget)) throw new Error("Bridge exact authenticated peer/target mismatch");
      const id = incomingBridgeId(e.source.instanceId, e.messageId);
      const evidence: Evidence = { schema: "pi-mesh.host-bridge/v1", direction: "incoming", local: s.local, source: { sessionId: e.source.id, instanceId: e.source.instanceId }, messageId: e.messageId, target: r.localTarget, routeId: r.routeId, mode: r.mode, envelope, claim: CLAIM };
      const reservation = passive(id, evidence);
      // Validation/reads are permitted before claim, never writes or notifications.
      recheck(s, r);
      if (!existing(s.spoolRoot).some(m => m.id === id)) consume(s.spoolRoot, r.localTarget, true);
      recheck(s, r); bridgeEnvelope(e.text);
      if (!e.reply({ handled: true })) return;
      try {
        recheck(s, r); bridgeEnvelope(e.text);
        if (existing(s.spoolRoot).some(m => m.id === id)) return;
      } catch (error) {
        const stage = "claimed-before-reservation";
        diagnostic({ id, stage, error: preview(error) }, true);
        // A successful claim is not continuing write authority. Only a native
        // read failure followed by a fresh, healthy exact authorization check
        // may leave passive evidence. Never retry canonical admission here.
        if (!/^E[A-Z]+$/.test((error as NodeJS.ErrnoException)?.code ?? "")) return;
        try {
          recheck(s, r); bridgeEnvelope(e.text);
          if (existing(s.spoolRoot).some(m => m.id === id)) return;
          consume(s.spoolRoot, r.localTarget);
          failureEvidence(s.spoolRoot, reservation, { id, stage, outcome: "not-stored", code: (error as NodeJS.ErrnoException).code, error: preview(error, 512) });
        } catch (fenced) { diagnostic({ id, stage, evidence: { outcome: "not-attempted", error: preview(fenced) } }, true); }
        return;
      }
      const admission = reserve(s.spoolRoot, r.localTarget, reservation);
      if ("duplicate" in admission && admission.duplicate) return;
      if (admission.outcome !== "stored" && admission.outcome !== "stored-visible") {
        failureEvidence(s.spoolRoot, reservation, admission); return;
      }
      let mailbox: unknown = { outcome: "not-requested" }, notification = "not-requested";
      try {
        if (admission.outcome === "stored") {
          const now = recheck(s, r); bridgeEnvelope(e.text);
          if (r.localTarget.kind === "mesh") {
            const t = r.localTarget;
            const delivery: ControlMessage = { id, runId: t.runId, from: "host", source: "host", displayFrom: `Authenticated relay ${e.source.instanceId}; NOT user authority`, to: t.nodeId, content: p.content, createdAt: Date.now(), bridge: { inboxId: id, sourceSessionId: e.source.id, sourceInstanceId: e.source.instanceId, origin: envelope.origin, correlationId: envelope.correlationId, expiresAt: envelope.expiresAt, hops: envelope.hops, budget: envelope.budget, routeId: r.routeId, claim: CLAIM } };
            mailbox = stored(s.root, delivery, { payloadMaxBytes: now.settings.messagePayloadMaxBytes, recipientUnreadMaxBytes: now.settings.recipientUnreadMaxBytes, ifAbsent: true });
          }
          // Store mode NEVER calls the general mailbox callback, even if enabled.
          const key = JSON.stringify(r.localTarget);
          if (r.mode === "active" && (r.localTarget.kind === "direct" || (mailbox as any).outcome === "stored") && (hints.get(key) ?? 0) < 8 && entries(s.spoolRoot).filter(m => { const v = JSON.parse(m.content) as Evidence; return v.mode === "active" && same(v.target, r.localTarget); }).length <= 8) {
            const currentScope = recheck(s, r); bridgeEnvelope(e.text);
            hints.set(key, (hints.get(key) ?? 0) + 1);
            notification = target(currentScope, r.localTarget)(p.content) ? "submitted-not-completed" : "inactive-not-submitted";
          }
        }
      } catch (error) { diagnostic(error); notification = "fenced-not-submitted"; }
      const outcome = stored(s.spoolRoot, passive(`${id}-outcome`, { inboxId: id, admission, mailbox, notification, completed: false }));
      if (outcome.outcome !== "stored") diagnostic({ id, admission: receiptCore(admission), outcome: receiptCore(outcome) }, true);
    } catch (error) { diagnostic(error); }
  };
  const close = () => { unsubscribe?.(); unsubscribe = undefined; current?.abort.abort(); current = undefined; };
  pi.on("session_start", (_event, ctx) => {
    close();
    if (managedBridgeChild(pi.events)) return;
    current = { ctx, root: fs.realpathSync(path.resolve(ctx.cwd)), sessionId: ctx.sessionManager.getSessionId(), spoolRoot: bridgeSpoolRoot(), abort: new AbortController() };
    unsubscribe = pi.events.on(RECEIVED, receive);
  });
  pi.on("session_shutdown", async () => { close(); await Promise.allSettled([...pending]); });

  return {
    async execute(action: string, args: { routeId?: string; content?: string; messageId?: string; forwardInboxId?: string }, signal: AbortSignal | undefined, ctx: ExtensionContext) {
      const host = hostScope(ctx);
      if (action === "bridge_status") {
        let local: Identity | null = null;
        try { local = bridgeLocal(pi.events, host.sessionId); } catch (error) { diagnostic(error); }
        const routes = host.settings.bridge.routes;
        const routesOmitted = Buffer.byteLength(JSON.stringify(routes)) > 8 * 1024;
        return { enabled: host.settings.bridge.enabled, local, totalUsed: total, totalLimit: 256, targetLimit: 64, hintLimit: 8, evidenceCount: entries(host.spoolRoot).length, failureCount: existing(host.spoolRoot).filter(m => m.id.startsWith("failure-") && JSON.parse(m.content).local?.sessionId === host.sessionId).length, diagnostics: [...diagnostics],
          routes: routesOmitted ? routes.map(({ routeId, peerInstanceId, remoteRoute, mode }) => ({ routeId, peerInstanceId, remoteRoute, mode })) : routes,
          ...(routesOmitted ? { routesOmitted: true, routesReference: "getAgentDir()/mesh/settings.yaml: bridge.routes (select exact routeId for full targets)" } : {}),
          meaning: "Cross accepted is only a synchronous claim; inspect local inbox/outcome IDs. Unknown is NOT safe retry." };
      }
      const all = existing(host.spoolRoot);
      const ownedIds = new Set(all.filter(m => JSON.parse(m.content).local?.sessionId === host.sessionId).map(m => m.id));
      const own = all.filter(m => { const v = JSON.parse(m.content); return v.local ? ownedIds.has(m.id) : ownedIds.has(v.inboxId); });
      if (action === "bridge_inbox") {
        const selected = own.filter(m => args.messageId ? m.id === args.messageId || JSON.parse(m.content).inboxId === args.messageId : !m.id.endsWith("-outcome"));
        const full = Boolean(args.messageId) && Buffer.byteLength(JSON.stringify(selected)) <= 40 * 1024;
        const summaries = selected.map(m => ({ id: m.id, createdAt: m.createdAt, ackedAt: m.ackedAt }));
        // Up to 256 reservations + 256 independent failures. Keep EVERY ID
        // discoverable even when metadata would exhaust the tool detail budget.
        const compact = Buffer.byteLength(JSON.stringify(summaries)) > 40 * 1024;
        return { namespace: BRIDGE_INBOX, count: selected.length, entries: full ? selected : compact ? selected.map(m => ({ id: m.id })) : summaries,
          ...(compact ? { metadataOmitted: true } : {}),
          ...(args.messageId && !full && selected.length ? { evidencePath: path.join(meshDir(host.spoolRoot), "messages", BRIDGE_INBOX, `${selected[0]!.id}.json`), contentsOmitted: true } : {}),
          meaning: "Use messageId for local evidence (large bodies remain at evidencePath); ack retains dedup tombstones." };
      }
      if (action === "bridge_ack") {
        if (!args.messageId || !own.some(m => m.id === args.messageId) || !ackMessage(host.spoolRoot, BRIDGE_INBOX, args.messageId, own.find(m => m.id === args.messageId)!.to)) throw new Error("Unknown/unowned/already acknowledged bridge inbox ID");
        return { id: args.messageId, acknowledged: true, completed: false };
      }
      if (action !== "bridge_send" || !args.routeId) throw new Error("bridge_send requires a fixed routeId");
      if (args.messageId !== undefined) throw new Error("bridge_send does not accept replacement message IDs; inspect the original receipt/inbox ID, never auto-retry unknown");
      const s = scope(ctx);
      if (signal?.aborted) throw new Error("Bridge send cancelled before admission");
      const r = route(s, args.routeId);
      let envelope: BridgeEnvelope;
      if (args.forwardInboxId !== undefined) {
        if (args.content !== undefined) throw new Error("Forward content comes only from the existing local inbox");
        const original = own.find(m => m.id === args.forwardInboxId && m.id.startsWith("in-") && !m.id.endsWith("-outcome"));
        if (!original) throw new Error("Forward requires an owned existing incoming inbox ID");
        const evidence = JSON.parse(original.content) as Evidence;
        if (evidence.schema !== "pi-mesh.host-bridge/v1" || evidence.direction !== "incoming") throw new Error("Invalid local forward evidence");
        const old = evidence.envelope, p = payload(old.payload);
        envelope = { ...old, hops: old.hops + 1, budget: old.budget - 1, payload: { ...p, route: r.remoteRoute, target: r.remoteTarget } };
      } else {
        envelope = { version: 1, origin: s.local.instanceId, correlationId: crypto.randomUUID(), expiresAt: Date.now() + 30_000, hops: 0, budget: 4, payload: payload({ version: 1, route: r.remoteRoute, target: r.remoteTarget, content: args.content, claim: CLAIM }) };
      }
      const text = BRIDGE_PREFIX + JSON.stringify(envelope);
      bridgeEnvelope(text);
      if (Buffer.byteLength(text) > 48 * 1024) throw new Error("Bridge envelope exceeds 48KiB serialized budget (including escaping)");
      recheck(s, r); consume(s.spoolRoot, r.localTarget, true);
      const messageId = crypto.randomUUID(), id = `out-${messageId}`;
      const reservation = passive(id, { schema: "pi-mesh.host-bridge/v1", direction: "outgoing", local: s.local, source: { sessionId: s.sessionId, instanceId: s.local.instanceId }, messageId, target: r.localTarget, routeId: r.routeId, envelope, claim: CLAIM, remoteInstanceId: r.peerInstanceId, forwardedFrom: args.forwardInboxId });
      const admission = reserve(s.spoolRoot, r.localTarget, reservation);
      if (admission.outcome !== "stored") {
        const outcome = admission.outcome === "stored-visible"
          ? stored(s.spoolRoot, passive(`${id}-outcome`, { inboxId: id, admission, sent: false, completed: false }))
          : failureEvidence(s.spoolRoot, reservation, admission);
        return { id, messageId, admission, outcome, sent: false, completed: false };
      }
      const run = (async () => {
        let receipt: unknown;
        try {
          recheck(s, r); bridgeEnvelope(text);
          const request = { version: 1 as const, requestId: crypto.randomUUID(), local: s.local, remoteInstanceId: r.peerInstanceId, messageId, text };
          const reply = await requestRpc(pi.events, RPC_SEND, request, 5000, AbortSignal.any([s.abort.signal, ...(signal ? [signal] : [])])) as any;
          if (typeof reply?.ok !== "boolean" || !same(reply.local, s.local) || (reply.ok === false && (typeof reply.code !== "string" || typeof reply.state !== "string" || typeof reply.retryable !== "boolean")) || (reply.ok === true && (reply.messageId !== messageId || reply.target?.instanceId !== r.peerInstanceId))) throw new Error("Uncorrelated Cross receipt");
          // PublicPeer display metadata is not authority or a reason to lose core IDs.
          receipt = { ...reply, ...(reply.target ? { target: { id: reply.target.id, instanceId: reply.target.instanceId } } : {}) };
        } catch (error) { receipt = { code: "receipt_unknown", state: "receipt_unknown", retryable: false, error: String(error).slice(0, 1024) }; }
        const outcome = stored(s.spoolRoot, passive(`${id}-outcome`, { inboxId: id, admission, receipt, completed: false }));
        return { id, messageId, admission, receipt, outcome, completed: false, meaning: "Cross receipt is NOT remote storage/business completion. Never auto-retry unknown; inspect original IDs." };
      })();
      pending.add(run);
      try { return await run; } finally { pending.delete(run); }
    },
  };
}
