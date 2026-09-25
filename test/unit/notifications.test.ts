import assert from "node:assert/strict";
import test from "node:test";
import { CHILD_OUTPUT_DISCLAIMER, CompletionNotifier } from "../../src/notifications.ts";
import { defaultMeshSettings } from "../../src/settings.ts";

const record = (id: string) => ({ id, status: "completed", agent: { name: "a" }, description: id } as any);
test("completion notifier deduplicates and groups results", async () => {
  const messages: any[] = [];
  const notifier = new CompletionNotifier({ sendMessage(message: any) { messages.push(message); } } as any, { ...defaultMeshSettings, joinMode: "group" });
  notifier.enqueue(record("1"), (item) => item.id); notifier.enqueue(record("2"), (item) => item.id); notifier.enqueue(record("1"), (item) => item.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(messages.length, 1); assert.match(messages[0].content, /1[\s\S]*2/); notifier.dispose();
});

test("completion notifier accepts mesh completion messages and wakes an idle Host", () => {
  const messages: any[] = [];
  const notifier = new CompletionNotifier({ sendMessage(message: any, options: any) { messages.push({ message, options }); } } as any, { ...defaultMeshSettings, joinMode: "async" });
  notifier.enqueueMessage("mesh:r1", "Mesh r1 finished: succeeded.");
  notifier.enqueueMessage("mesh:r1", "duplicate");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /Mesh r1 finished/);
  assert.deepEqual(messages[0].message.details.ids, ["mesh:r1"]);
  assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });
  notifier.dispose();
});

test("deduplicates within/across batches by generation and suppresses only foreground", () => {
  const messages: any[] = [];
  const notifier = new CompletionNotifier({ sendMessage: (message: any) => messages.push(message) } as any, { ...defaultMeshSettings, joinMode: "group" });
  for (let i = 0; i < 3; i++) notifier.enqueue({ ...record("same"), generation: 1 }, () => "GEN1");
  notifier.flush(); notifier.enqueue({ ...record("same"), generation: 1 }, () => "REPLAY"); notifier.flush();
  notifier.enqueue({ ...record("same"), generation: 2 }, () => "GEN2"); notifier.flush();
  notifier.enqueue({ ...record("same"), generation: 3, foreground: true }, () => "FOREGROUND"); notifier.flush();
  assert.deepEqual(messages.map((item) => item.content), ["GEN1", "GEN2"]); notifier.dispose();
});

for (const joinMode of ["smart", "group", "async"] as const) test(`${joinMode}: split bounded notifications without losing provenance or continuation details/hints`, () => {
  const sent: any[] = [], authorized: Array<{ id: string; details: object }> = [];
  const notifier = new CompletionNotifier({ sendMessage(message: any) { sent.push(message); } } as any, { ...defaultMeshSettings, joinMode });
  try {
    for (const [id, body] of [["a", `${"界".repeat(1000)}\n`.repeat(20)], ["b", "line\n".repeat(2500)], ["c", "z".repeat(48 * 1024)], ["denied", "small"]]) {
      notifier.enqueueMessage(id!, `${CHILD_OUTPUT_DISCLAIMER}\n${id}\n${body}`, false, details => {
        authorized.push({ id: id!, details }); return id !== "denied";
      }, `\nCONTINUE_${id}`);
    }
    notifier.flush();
    assert.ok(sent.length >= 3, "large results must not be concatenated into one oversized follow-up");
    assert.deepEqual(sent.flatMap(message => message.details.ids), ["a", "b", "c", "denied"]);
    for (const message of sent) {
      assert.ok(Buffer.byteLength(message.content) <= 50 * 1024);
      assert.ok(message.content.split("\n").length <= 2000);
      assert.match(message.content, /^Child agent output and diagnostics/);
      assert.doesNotMatch(message.content, /CONTINUE_denied|\uFFFD/);
      for (const id of message.details.ids) {
        const calls = authorized.filter(call => call.id === id);
        assert.equal(calls.length, 1); assert.equal(calls[0]!.details, message.details, "authorize only the exact delivered batch");
        if (id !== "denied") assert.ok(message.content.includes(`\nCONTINUE_${id}`), "never truncate an authorized hint");
      }
    }
    assert.ok(sent.some(message => /Notification truncated/.test(message.content)));
    notifier.enqueueMessage("a", "replay", false, () => assert.fail("duplicate authority")); notifier.flush();
    assert.equal(authorized.length, 4);
    assert.throws(() => notifier.enqueueMessage("oversize-hint", "data", false, () => assert.fail("oversize hint must not authorize"), "x".repeat(51 * 1024)), /hint exceeds notification budget/);
  } finally { notifier.dispose(); }
});
