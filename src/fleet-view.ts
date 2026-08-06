import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MeshManager } from "./manager.ts";
import type { Usage } from "./pi-process.ts";
import type { SessionAgentManager, SessionAgentRecord } from "./session-agents.ts";
import { ConversationViewer } from "./conversation-viewer.ts";

const TICK_MS = 200;
const FINISHED_LINGER_MS = 5000;
const MAX_ROWS = 5;

type Activity = SessionAgentRecord["activity"];
type FleetRecord = {
  key: string;
  id: string;
  agent: string;
  description: string;
  status: string;
  createdAt: number;
  completedAt?: number;
  maxTurns?: number;
  activity?: Activity;
  usage?: Usage;
  conversation(): string;
  stop(): boolean;
  steer(message: string): void;
};

function statusIcon(status: string): string {
  if (status === "running") return "●";
  if (status === "completed" || status === "succeeded") return "✓";
  if (status === "failed") return "✗";
  if (status === "queued" || status === "paused") return "◦";
  return "■";
}
function formatElapsed(ms: number): string { return `${Math.max(0, Math.round(ms / 1000))}s`; }
function formatTokens(record: FleetRecord): string {
  const usage = record.usage ?? record.activity?.usage;
  const count = usage ? usage.input + usage.output + usage.cacheWrite : 0;
  if (!count) return "";
  const compact = count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
  return `↓ ${compact} tokens`;
}
function rightAlign(left: string, right: string, width: number): string {
  const maxLeft = Math.max(0, width - visibleWidth(right) - 1);
  const clamped = truncateToWidth(left, maxLeft);
  return truncateToWidth(`${clamped}${" ".repeat(Math.max(1, width - visibleWidth(clamped) - visibleWidth(right)))}${right}`, width);
}

export class FleetView {
  private ctx?: ExtensionContext;
  private ui: any;
  private tui: any;
  private sessionKey?: string;
  private directManager?: SessionAgentManager;
  private meshManager?: MeshManager;
  private inputUnsub?: () => void;
  private timer?: NodeJS.Timeout;
  private active = false;
  private selected = 0;
  private viewerOpen = false;
  private widgetRegistered = false;

  bind(ctx: ExtensionContext, manager: SessionAgentManager, key: string): void {
    if (ctx.mode !== "tui") return;
    this.bindContext(ctx, key); this.directManager = manager; this.render();
  }

  bindMesh(ctx: ExtensionContext, manager: MeshManager, key: string): void {
    if (ctx.mode !== "tui") return;
    this.bindContext(ctx, key); this.meshManager = manager; this.render();
  }

  private bindContext(ctx: ExtensionContext, key: string): void {
    if (this.sessionKey !== key || this.ui !== ctx.ui) {
      if (this.ui && this.widgetRegistered) this.ui.setWidget("pi-mesh-fleet", undefined);
      this.inputUnsub?.(); this.directManager = undefined; this.meshManager = undefined;
      this.sessionKey = key; this.ctx = ctx; this.ui = ctx.ui; this.tui = undefined; this.widgetRegistered = false; this.active = false; this.selected = 0;
      this.inputUnsub = ctx.ui.onTerminalInput((data) => this.handleKey(data));
    }
    if (!this.timer) { this.timer = setInterval(() => this.render(), TICK_MS); this.timer.unref?.(); }
  }

  private records(): FleetRecord[] {
    const now = Date.now();
    const records: FleetRecord[] = [];
    for (const record of this.directManager?.list() ?? []) {
      if (!["running", "queued"].includes(record.status) && (!record.completedAt || now - record.completedAt >= FINISHED_LINGER_MS)) continue;
      records.push({
        key: `agent:${record.id}`, id: record.id, agent: record.agent.name, description: record.description, status: record.status,
        createdAt: record.createdAt, completedAt: record.completedAt, maxTurns: record.launch?.maxTurns, activity: record.activity, usage: record.result?.usage,
        conversation: () => record.execution?.conversation() || record.result?.output || record.error || "Waiting…",
        stop: () => this.directManager?.abort(record.id) ?? false,
        steer: (message) => this.directManager?.steer(record.id, message),
      });
    }
    for (const run of this.meshManager?.list() ?? []) {
      const runRecent = Boolean(run.finishedAt && now - run.finishedAt < FINISHED_LINGER_MS);
      if (!["running", "paused", "cancelling"].includes(run.status) && !runRecent) continue;
      for (const node of run.nodes) {
        const completedAt = node.finishedAt ?? (node.status === "skipped" ? run.finishedAt : undefined);
        if (!["running", "queued", "paused"].includes(node.status) && (!completedAt || now - completedAt >= FINISHED_LINGER_MS)) continue;
        records.push({
          key: `mesh:${run.id}:${node.id}`, id: `${run.id}/${node.id}`, agent: node.agent, description: node.task, status: node.status,
          createdAt: node.startedAt ?? run.createdAt, completedAt, activity: node.activity, usage: node.usage,
          conversation: () => this.meshManager?.conversation(run.id, node.id) || node.output || node.error || "Waiting…",
          stop: () => this.meshManager?.cancel(run.id, node.id) ?? false,
          steer: (message) => { if (!this.meshManager?.steer(run.id, node.id, message)) throw new Error("Mesh node is not running"); },
        });
      }
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  private render(): void {
    if (!this.ui) return;
    const records = this.records();
    if (!records.length) {
      if (this.widgetRegistered) this.ui.setWidget("pi-mesh-fleet", undefined);
      this.widgetRegistered = false; this.tui = undefined; this.active = false; this.selected = 0;
      return;
    }
    this.selected = Math.min(this.selected, records.length);
    if (!this.widgetRegistered) {
      this.ui.setWidget("pi-mesh-fleet", (tui: any, theme: Theme) => {
        this.tui = tui;
        return { render: (width: number) => this.renderPanel(width, theme), invalidate: () => {} };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else this.tui?.requestRender();
  }

  private renderPanel(width: number, theme: Theme): string[] {
    const records = this.records();
    if (!records.length) return [];
    this.selected = Math.min(this.selected, records.length);
    const hint = this.active ? "↑↓ select · enter view · esc back" : "←/↓ open agents · esc still interrupts main";
    const lines = [truncateToWidth(`  ${theme.fg("dim", hint)}`, width), "", truncateToWidth(`  ${this.selected === 0 ? theme.fg("accent", "●") : theme.fg("dim", "○")} main`, width)];
    const visible = Math.min(MAX_ROWS, records.length);
    const selectedAgent = Math.max(0, this.selected - 1);
    const start = selectedAgent < visible ? 0 : selectedAgent - visible + 1;
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let index = start; index < start + visible; index++) {
      const record = records[index]!;
      const marker = index + 1 === this.selected ? theme.fg("accent", "●") : theme.fg("dim", "○");
      const left = `  ${marker} ${statusIcon(record.status)} ${theme.fg("muted", record.agent)}  ${record.description}`;
      const activity = record.activity;
      const stats = [activity?.turns ? `↻${activity.turns}` : "", activity?.toolUses ? `${activity.toolUses} tools` : "", formatElapsed((record.completedAt ?? Date.now()) - record.createdAt), formatTokens(record)].filter(Boolean).join(" · ");
      lines.push(rightAlign(left, theme.fg("dim", stats), width));
    }
    const hidden = records.length - start - visible;
    if (hidden > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hidden} more`), width));
    return lines;
  }

  private handleKey(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data) || this.viewerOpen || !this.ctx || !this.records().length || this.ui?.getEditorText() !== "") return undefined;
    const focused = this.tui?.focusedComponent;
    if (focused != null && !(focused instanceof Editor)) { this.active = false; this.selected = 0; this.render(); return undefined; }
    if (!this.active) {
      if (!matchesKey(data, "down") && !matchesKey(data, "left")) return undefined;
      this.active = true; this.selected = 0; this.render(); return { consume: true };
    }
    if (matchesKey(data, "down")) { this.selected = Math.min(this.records().length, this.selected + 1); this.render(); return { consume: true }; }
    if (matchesKey(data, "up")) { if (this.selected === 0) this.active = false; else this.selected--; this.render(); return { consume: true }; }
    if (matchesKey(data, "escape")) { this.active = false; this.selected = 0; this.render(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) {
      if (this.selected === 0) { this.active = false; this.render(); return { consume: true }; }
      const record = this.records()[this.selected - 1]; if (record) void this.openRecord(this.ctx, record);
      return { consume: true };
    }
    this.active = false; this.selected = 0; this.render(); return undefined;
  }

  async select(ctx: ExtensionContext, manager: SessionAgentManager): Promise<void> {
    if (ctx.mode !== "tui") return;
    const records = manager.list();
    if (!records.length) return void ctx.ui.notify("No subagents yet.", "info");
    const selected = await ctx.ui.select("Agent fleet", records.map((record) => `${statusIcon(record.status)} ${record.agent.name} · ${record.description} · ${record.status} · ${record.id}`));
    if (selected) await this.open(ctx, manager, selected.split(" · ").at(-1)!);
  }

  async open(ctx: ExtensionContext, manager: SessionAgentManager, id: string): Promise<void> {
    const record = manager.get(id); if (!record || ctx.mode !== "tui") return;
    await this.openRecord(ctx, {
      key: `agent:${record.id}`, id: record.id, agent: record.agent.name, description: record.description, status: record.status,
      createdAt: record.createdAt, completedAt: record.completedAt, maxTurns: record.launch?.maxTurns, activity: record.activity, usage: record.result?.usage,
      conversation: () => record.execution?.conversation() || record.result?.output || record.error || "Waiting…",
      stop: () => manager.abort(record.id), steer: (message) => manager.steer(record.id, message),
    });
  }

  private async openRecord(ctx: ExtensionContext, record: FleetRecord): Promise<void> {
    if (ctx.mode !== "tui") return;
    this.viewerOpen = true;
    try {
      await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => new ConversationViewer(
        tui,
        theme,
        keybindings,
        () => {
          const current = this.records().find((item) => item.key === record.key) ?? record;
          const usage = current.usage ?? current.activity?.usage;
          return {
            ...current,
            turns: current.activity?.turns,
            toolUses: current.activity?.toolUses,
            tokens: usage ? usage.input + usage.output + usage.cacheWrite : 0,
            activeTools: current.activity?.activeTools,
            responseText: current.activity?.responseText,
            thinkingText: current.activity?.thinkingText,
          };
        },
        () => done(undefined),
        () => { const current = this.records().find((item) => item.key === record.key); if (current && ["running", "queued", "paused"].includes(current.status)) current.stop(); },
        (message) => { const current = this.records().find((item) => item.key === record.key); if (current?.status === "running") current.steer(message); },
      ), { overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 52, maxHeight: "70%", visible: (width) => width >= 60 } });
    } finally { this.viewerOpen = false; this.render(); }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.inputUnsub?.(); this.inputUnsub = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget("pi-mesh-fleet", undefined);
    this.ctx = undefined; this.ui = undefined; this.tui = undefined; this.sessionKey = undefined; this.directManager = undefined; this.meshManager = undefined;
    this.widgetRegistered = false; this.active = false; this.selected = 0; this.viewerOpen = false;
  }
}
