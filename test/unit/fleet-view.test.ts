import assert from "node:assert/strict";
import test from "node:test";
import { FleetView } from "../../src/fleet-view.ts";

const record = { id: "12345678-rest", status: "running", agent: { name: "worker" }, description: "fix the bug", execution: { conversation: () => "line one\nline two", steer() {}, abort() {}, close: async () => {}, session: {} } } as any;

test("FleetView binds once and opens a keybinding-safe conversation overlay", async () => {
  const widgets: any[] = []; let overlay: any; let renderRequests = 0;
  const manager = { list: () => [record], get: () => record, abort: () => true, steer() {} } as any;
  const ctx: any = {
    mode: "tui",
    ui: {
      theme: { fg: (_c: string, value: string) => value },
      setWidget: (...args: any[]) => widgets.push(args),
      notify() {}, input: async () => undefined, select: async () => undefined,
      custom: async (factory: any) => {
        overlay = factory({ requestRender: () => renderRequests++ }, { fg: (_c: string, value: string) => value, bold: (value: string) => value }, { matches: (data: string, id: string) => (id === "tui.select.cancel" && data === "escape") || (id === "tui.select.down" && data === "down") || (id === "tui.select.up" && data === "up") }, () => undefined);
        return undefined;
      },
    },
  };
  const fleet = new FleetView(); fleet.bind(ctx, manager, "project"); fleet.bind(ctx, manager, "project");
  assert.equal(widgets.length, 1); assert.match(widgets[0][1].join("\n"), /worker[\s\S]*fix the bug/);
  await fleet.open(ctx, manager, record.id);
  assert.ok(overlay.render(60).every((line: string) => !line.includes("undefined")));
  overlay.handleInput("down"); assert.equal(renderRequests, 1); overlay.dispose(); fleet.dispose();
});
