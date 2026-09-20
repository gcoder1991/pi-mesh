import assert from "node:assert/strict";
import test from "node:test";
import { continuationTasks, requestContinuation, successfulEpoch } from "../../src/continuation.ts";
import { CompletionNotifier } from "../../src/notifications.ts";
import { defaultMeshSettings } from "../../src/settings.ts";

test("continuation fixes task budgets, excludes scope/policy/recursive overrides and snapshots text", () => {
  const input = [{ agent: "reviewer", task: "Original review" }];
  const planned = continuationTasks(input); input[0]!.task = "Forged after authorization";
  assert.deepEqual(planned, [{ id: "continuation-1", agent: "reviewer", task: "Original review", timeoutMs: 600000, retries: 0 }]);
  for (const value of [[], Array(5).fill({ agent: "a", task: "b" }), [{ agent: "a", task: "b", cwd: "/other" }], [{ agent: "a", task: "b", retries: 1 }], [{ agent: "a", task: "b", model: "other" }], [{ agent: "a", task: "b", continuationTasks: [] }]]) assert.throws(() => continuationTasks(value));
});

test("continuation only admits original fully successful epoch with no run/node stop or retry", () => {
  const run: any = { epoch: 1, status: "succeeded", nodes: [{ status: "succeeded", attempt: 1 }] };
  assert.equal(successfulEpoch(run, 1), true);
  for (const change of [{ epoch: 2 }, { status: "failed" }, { status: "cancelled" }, { status: "paused" }, { autoContinueBlocked: true }, { cancelSource: "user" }, { cancelSource: "unknown" }, { cancelSource: "operator" }]) assert.equal(successfulEpoch({ ...run, ...change }, 1), false);
  for (const change of [{ status: "cancelled" }, { attempt: 2 }, { autoContinueBlocked: true }, { cancelSource: "unknown" }]) assert.equal(successfulEpoch({ ...run, nodes: [{ ...run.nodes[0], ...change }] }, 1), false);
});

test("missing/old Cross fails closed; async bus response cannot authorize", () => {
  const ctx: any = { cwd: "/root", sessionManager: { getSessionId: () => "host" } };
  let reply: any;
  const pi: any = { events: { emit(_name: string, value: any) { reply = value.reply; } } };
  assert.throws(() => requestContinuation(pi, ctx, "call", {}), /no run created/);
  reply(Object.freeze({ bind() {}, complete() { return true; }, claim() { return true; } }));
});

test("grouped notifier authorizes only at flush using exact live SDK details, with no serialized token", () => {
  const authorized: object[] = [], sent: any[] = [];
  const notifier = new CompletionNotifier({ sendMessage(message: any) { sent.push(message); } } as any, { ...defaultMeshSettings, joinMode: "group" });
  notifier.enqueueMessage("run-a", "a", false, details => { authorized.push(details); });
  notifier.enqueueMessage("run-b", "b", false, details => { authorized.push(details); });
  assert.equal(authorized.length, 0); notifier.flush();
  assert.equal(authorized.length, 2); assert.equal(authorized[0], sent[0].details); assert.equal(authorized[1], sent[0].details);
  assert.deepEqual(sent[0].details, { ids: ["run-a", "run-b"] });
  notifier.enqueueMessage("run-a", "replay", false, () => assert.fail("duplicate authority")); notifier.flush();
  notifier.enqueueMessage("run-c", "disposed", false, () => assert.fail("disposed authority")); notifier.dispose(); notifier.flush();
  assert.equal(sent.length, 1);
});
