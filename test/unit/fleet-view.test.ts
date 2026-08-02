import assert from "node:assert/strict";
import test from "node:test";
import { FleetView } from "../../src/fleet-view.ts";

const record = { id: "12345678-rest", status: "running", createdAt: Date.now() - 11_000, agent: { name: "worker" }, description: "fix the bug", launch: { maxTurns: 30 }, activity: { turns: 3, toolUses: 2, responseText: "reviewing files", activeTools: ["read"], usage: { input: 12_000, output: 1_000, cacheRead: 0, cacheWrite: 100, cost: 0, turns: 3 } }, execution: { conversation: () => "line one\nline two", steer() {}, abort() {}, close: async () => {}, session: {} } } as any;
const theme = { fg: (_c: string, value: string) => value, bold: (value: string) => value } as any;

test("FleetView renders a navigable main panel and conversation overlay", async () => {
  let widgetFactory: any; let inputHandler: any; let overlay: any; let renderRequests = 0; let editorText = "";
  const manager = { list: () => [record], get: () => record, abort: () => true, steer() {} } as any;
  const ctx: any = {
    mode: "tui",
    ui: {
      theme,
      setWidget: (_key: string, value: any) => { widgetFactory = value; },
      onTerminalInput: (handler: any) => { inputHandler = handler; return () => { inputHandler = undefined; }; },
      getEditorText: () => editorText,
      notify() {}, input: async () => undefined, select: async () => undefined,
      custom: async (factory: any) => {
        overlay = factory({ requestRender: () => renderRequests++ }, theme, { matches: (data: string, id: string) => (id === "tui.select.cancel" && data === "escape") || (id === "tui.select.down" && data === "down") || (id === "tui.select.up" && data === "up") }, () => undefined);
        return undefined;
      },
    },
  };
  const fleet = new FleetView(); fleet.bind(ctx, manager, "project"); fleet.bind(ctx, manager, "project");
  const render = () => widgetFactory({ requestRender: () => renderRequests++ }, theme).render(100).join("\n");
  assert.match(render(), /main[\s\S]*worker[\s\S]*fix the bug[\s\S]*↻3≤30[\s\S]*2 tools[\s\S]*11s[\s\S]*13\.1k tokens[\s\S]*read/);
  assert.deepEqual(inputHandler("\u001b[B"), { consume: true });
  assert.match(render(), /enter view/);
  assert.deepEqual(inputHandler("\u001b[B"), { consume: true });
  assert.deepEqual(inputHandler("\r"), { consume: true });
  await Promise.resolve();
  assert.ok(overlay.render(60).every((line: string) => !line.includes("undefined")));
  overlay.handleInput("down"); assert.ok(renderRequests > 0); overlay.dispose();
  editorText = "typing"; assert.equal(inputHandler("\u001b[B"), undefined);
  fleet.dispose();
});

test("FleetView includes active mesh nodes in the same main panel", () => {
  let widgetFactory: any;
  const run = { id: "run-12345678", status: "running", createdAt: Date.now() - 5000, nodes: [{ id: "review", agent: "reviewer", task: "review changes", status: "running", startedAt: Date.now() - 3000, dependsOn: [], retries: 0, attempt: 1, cwd: process.cwd(), activity: { turns: 2, toolUses: 1, responseText: "", activeTools: ["read"], usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 } } }] };
  const manager = { list: () => [run], conversation: () => "mesh conversation", cancel: () => true, steer: () => true } as any;
  const ctx: any = { mode: "tui", ui: { setWidget: (_key: string, value: any) => { widgetFactory = value; }, onTerminalInput: () => () => {}, getEditorText: () => "" } };
  const fleet = new FleetView(); fleet.bindMesh(ctx, manager, "project");
  const output = widgetFactory({ requestRender() {} }, theme).render(100).join("\n");
  assert.match(output, /main[\s\S]*reviewer[\s\S]*review changes[\s\S]*↻2[\s\S]*1 tools[\s\S]*read/);
  fleet.dispose();
});
