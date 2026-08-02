import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SessionAgentManager, SessionAgentRecord } from "./session-agents.ts";

function statusIcon(record: SessionAgentRecord): string {
  if (record.status === "running") return "●";
  if (record.status === "completed") return "✓";
  if (record.status === "failed") return "✗";
  return "■";
}

export class FleetView {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly bound = new Set<string>();

  bind(ctx: ExtensionContext, manager: SessionAgentManager, key: string): void {
    if (ctx.mode !== "tui" || this.bound.has(key)) return;
    this.bound.add(key);
    const render = () => {
      const records = manager.list().filter((record) => record.status === "running" || (record.completedAt && Date.now() - record.completedAt < 5000));
      ctx.ui.setWidget("pi-mesh-fleet", records.length ? [
        ctx.ui.theme.fg("dim", "Agent fleet · /agents or ctrl+shift+a"),
        ctx.ui.theme.fg("accent", "  ● main"),
        ...records.map((record) => `  ${statusIcon(record)} ${record.agent.name.padEnd(14)} ${record.description.slice(0, 48)} · ${record.status} · ${record.id.slice(0, 8)}`),
      ] : undefined, { placement: "belowEditor" });
    };
    render();
    const timer = setInterval(render, 250); timer.unref?.(); this.timers.add(timer);
  }

  async select(ctx: ExtensionContext, manager: SessionAgentManager): Promise<void> {
    if (ctx.mode !== "tui") return;
    const records = manager.list();
    if (!records.length) return void ctx.ui.notify("No subagents yet.", "info");
    const selected = await ctx.ui.select("Agent fleet", records.map((record) => `${statusIcon(record)} ${record.agent.name} · ${record.description} · ${record.status} · ${record.id}`));
    if (selected) await this.open(ctx, manager, selected.split(" · ").at(-1)!);
  }

  async open(ctx: ExtensionContext, manager: SessionAgentManager, id: string): Promise<void> {
    const record = manager.get(id); if (!record || ctx.mode !== "tui") return;
    const action = await ctx.ui.custom<"steer" | "stop" | undefined>((tui, theme, keybindings, done) => {
      let scroll = 0;
      let disposed = false;
      const component = {
        render: (width: number): string[] => {
          const current = manager.get(id) ?? record;
          const output = current.execution?.conversation() || current.result?.output || current.error || "Waiting…";
          const body = wrapTextWithAnsi(output, Math.max(1, width - 4));
          const max = Math.max(0, body.length - 16); scroll = Math.min(scroll, max);
          return [
            truncateToWidth(theme.fg("accent", theme.bold(`${current.agent.name} · ${current.status}`)), width),
            truncateToWidth(theme.fg("dim", `${current.description} · ${current.id}`), width),
            "",
            ...body.slice(scroll, scroll + 16).map((line) => truncateToWidth(`  ${line}`, width)),
            "",
            truncateToWidth(theme.fg("dim", `${scroll > 0 ? "↑ " : ""}${scroll < max ? "↓ " : ""}j/k scroll · s steer · x stop · esc close`), width),
          ];
        },
        handleInput: (data: string): void => {
          if (keybindings.matches(data, "tui.select.cancel")) return done(undefined);
          if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) scroll = Math.max(0, scroll - 1);
          else if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) scroll++;
          else if (matchesKey(data, "s")) return done("steer");
          else if (matchesKey(data, "x")) return done("stop");
          tui.requestRender();
        },
        invalidate(): void {},
        dispose(): void { disposed = true; clearInterval(timer); },
      };
      const timer = setInterval(() => { if (!disposed) tui.requestRender(); }, 250); timer.unref?.();
      return component;
    }, { overlay: true, overlayOptions: { anchor: "right-center", width: "70%", minWidth: 52, maxHeight: "80%", visible: (width) => width >= 60 } });
    if (action === "stop") manager.abort(id);
    if (action === "steer") { const message = await ctx.ui.input("Steer agent", "New instruction"); if (message) manager.steer(id, message); }
  }

  dispose(): void { for (const timer of this.timers) clearInterval(timer); this.timers.clear(); this.bound.clear(); }
}
