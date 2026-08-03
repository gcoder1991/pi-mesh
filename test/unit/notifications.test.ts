import assert from "node:assert/strict";
import test from "node:test";
import { CompletionNotifier } from "../../src/notifications.ts";
import { defaultMeshSettings } from "../../src/settings.ts";

const record = (id: string) => ({ id, status: "completed", agent: { name: "a" }, description: id } as any);
test("completion notifier deduplicates and groups results", async () => {
  const messages: any[] = [];
  const notifier = new CompletionNotifier({ sendMessage(message: any) { messages.push(message); } } as any, { ...defaultMeshSettings, joinMode: "group" });
  notifier.enqueue(record("1"), (item) => item.id); notifier.enqueue(record("2"), (item) => item.id); notifier.enqueue(record("1"), (item) => item.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(messages.length, 1); assert.match(messages[0].content, /1[\s\S]*2/); notifier.dispose();
});

test("completion notifier accepts mesh completion messages", () => {
  const messages: any[] = [];
  const notifier = new CompletionNotifier({ sendMessage(message: any) { messages.push(message); } } as any, { ...defaultMeshSettings, joinMode: "async" });
  notifier.enqueueMessage("mesh:r1", "Mesh r1 finished: succeeded.");
  notifier.enqueueMessage("mesh:r1", "duplicate");
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Mesh r1 finished/);
  assert.deepEqual(messages[0].details.ids, ["mesh:r1"]);
  notifier.dispose();
});
