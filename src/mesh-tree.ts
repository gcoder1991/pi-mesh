import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { MeshManager, MeshNode, MeshRun } from "./manager.ts";
import type { ViewerKeybindings } from "./conversation-viewer.ts";

const REFRESH_MS = 250;
const RECENT_RUN_MS = 20_000;
const ACTIVE_RUNS = new Set(["running", "paused", "cancelling"]);

type MeshTreeItem = { key: string; run: MeshRun; node: MeshNode; branch: string };
type Detail = { header: string[]; body: string[] };

function key(bindings: ViewerKeybindings | undefined, data: string, id: Parameters<ViewerKeybindings["matches"]>[1], fallback: string): boolean {
  return bindings ? bindings.matches(data, id) : matchesKey(data, fallback as any);
}

function glyph(status: string, theme: Theme): string {
  if (status === "running") return theme.fg("accent", "●");
  if (status === "queued") return theme.fg("muted", "◦");
  if (status === "paused") return theme.fg("warning", "Ⅱ");
  if (status === "succeeded" || status === "completed") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "cancelled") return theme.fg("warning", "⊘");
  return theme.fg("dim", "–");
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
  const clippedRight = truncateToWidth(right, Math.max(0, width - 1));
  const rightWidth = visibleWidth(clippedRight);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(clippedRight, rightWidth);
}

function elapsed(start: number | undefined, end: number | undefined, now: number): string {
  if (!start) return "";
  const seconds = Math.max(0, Math.round(((end ?? now) - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function tokens(node: MeshNode): string {
  const usage = node.usage ?? node.activity?.usage;
  if (!usage) return "";
  const count = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const compact = count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
  return `${compact} tok`;
}

function runItems(run: MeshRun): MeshTreeItem[] {
  const nodes = new Map(run.nodes.map((node) => [node.id, node]));
  const children = new Map<string, MeshNode[]>();
  const roots: MeshNode[] = [];
  for (const node of run.nodes) {
    const parent = node.dependsOn.find((id) => nodes.has(id));
    if (!parent) roots.push(node);
    else children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const items: MeshTreeItem[] = [];
  const seen = new Set<string>();
  const visit = (node: MeshNode, prefix: string, last: boolean): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    items.push({ key: `${run.id}/${node.id}`, run, node, branch: `${prefix}${last ? "└─" : "├─"}` });
    const nested = children.get(node.id) ?? [];
    nested.forEach((child, index) => visit(child, `${prefix}${last ? "  " : "│ "}`, index === nested.length - 1));
  };
  roots.forEach((node, index) => visit(node, "", index === roots.length - 1));
  for (const node of run.nodes) if (!seen.has(node.id)) visit(node, "", true);
  return items;
}

export function collectMeshTreeItems(runs: MeshRun[], now = Date.now()): MeshTreeItem[] {
  return runs
    .filter((run) => ACTIVE_RUNS.has(run.status) || now - (run.finishedAt ?? run.updatedAt) < RECENT_RUN_MS)
    .sort((left, right) => Number(ACTIVE_RUNS.has(right.status)) - Number(ACTIVE_RUNS.has(left.status)) || right.updatedAt - left.updatedAt)
    .flatMap(runItems);
}

// ponytail: keep this inspector read-only; existing Mesh controls remain the single mutation path.
export class MeshTreeComponent implements Component {
  private items: MeshTreeItem[] = [];
  private selected = 0;
  private selectedKey?: string;
  private detailScroll = 0;
  private detailAutoFollow = true;
  private detailLineCount = 0;
  private detailPageSize = 1;
  private bodyHeight = 8;
  private disposed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly tui: any;
  private readonly theme: Theme;
  private readonly keybindings: ViewerKeybindings | undefined;
  private readonly manager: MeshManager;
  private readonly done: () => void;

  constructor(
    tui: any,
    theme: Theme,
    keybindings: ViewerKeybindings | undefined,
    manager: MeshManager,
    done: () => void,
    refreshMs = REFRESH_MS,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.manager = manager;
    this.done = done;
    this.refresh();
    this.timer = setInterval(() => {
      if (this.disposed) return;
      this.refresh();
      this.tui.requestRender();
    }, refreshMs);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    if (key(this.keybindings, data, "tui.select.cancel", "escape") || matchesKey(data, "q")) return this.done();
    if (matchesKey(data, Key.shift("k"))) return this.scrollDetail(-1);
    if (matchesKey(data, Key.shift("j"))) return this.scrollDetail(1);
    if (key(this.keybindings, data, "tui.select.pageUp", "pageUp")) return this.scrollDetail(-this.detailPageSize);
    if (key(this.keybindings, data, "tui.select.pageDown", "pageDown")) return this.scrollDetail(this.detailPageSize);
    if (key(this.keybindings, data, "tui.select.up", "up") || matchesKey(data, "k")) return this.move(-1);
    if (key(this.keybindings, data, "tui.select.down", "down") || matchesKey(data, "j")) return this.move(1);
    if (matchesKey(data, "home")) return this.move(-this.items.length);
    if (matchesKey(data, "end")) return this.move(this.items.length);
    if (data.toLowerCase() === "r") {
      this.refresh();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 36) return [truncateToWidth("Mesh tree needs at least 36 columns. Esc closes.", width)];
    this.refresh();
    const innerWidth = width - 2;
    const rows = this.tui.terminal?.rows ?? 32;
    this.bodyHeight = Math.max(2, Math.min(30, Math.floor(rows * 0.85) - 6));
    const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
    const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
    const roster = this.roster(rosterWidth);
    const detail = this.detail(this.items[this.selected], detailWidth);
    const detailHeader = detail.header.slice(0, Math.max(0, this.bodyHeight - 1));
    this.detailPageSize = Math.max(1, this.bodyHeight - detailHeader.length);
    this.detailLineCount = detail.body.length;
    const maxScroll = Math.max(0, this.detailLineCount - this.detailPageSize);
    if (this.detailAutoFollow) this.detailScroll = maxScroll;
    else this.detailScroll = Math.min(this.detailScroll, maxScroll);
    const visibleDetail = [...detailHeader, ...detail.body.slice(this.detailScroll, this.detailScroll + this.detailPageSize)];

    const border = (text: string) => this.theme.fg("border", text);
    const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
    const current = this.items[this.selected];
    const title = ` ${this.theme.bold("Mesh tree inspector")} ${this.theme.fg("dim", "· inspection only · live")}`;
    const currentStatus = current ? `${glyph(current.node.status, this.theme)} ${current.node.agent} · ${current.node.status} ` : this.theme.fg("dim", "no nodes ");
    lines.push(border("│") + rightAligned(title, currentStatus, innerWidth) + border("│"));
    lines.push(border(`├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
    for (let index = 0; index < this.bodyHeight; index++) lines.push(border("│") + fit(roster[index] ?? "", rosterWidth) + border("│") + fit(visibleDetail[index] ?? "", detailWidth) + border("│"));
    lines.push(border(`├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
    const position = this.items.length ? `${this.selected + 1}/${this.items.length}` : "0/0";
    const footer = ` ↑↓/jk node · Shift+K/J scroll · PgUp/PgDn page · r refresh · Esc close · ${position}`;
    lines.push(border("│") + fit(this.theme.fg("dim", footer), innerWidth) + border("│"));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void { this.refresh(); }
  dispose(): void { this.disposed = true; clearInterval(this.timer); }

  private refresh(): void {
    const previousKey = this.items[this.selected]?.key ?? this.selectedKey;
    this.items = collectMeshTreeItems(this.manager.list());
    const preserved = previousKey ? this.items.findIndex((item) => item.key === previousKey) : -1;
    this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.items.length - 1));
    this.selectedKey = this.items[this.selected]?.key;
  }

  private move(delta: number): void {
    if (!this.items.length) return;
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
    this.selectedKey = this.items[this.selected]?.key;
    this.detailAutoFollow = true;
    this.tui.requestRender();
  }

  private scrollDetail(delta: number): void {
    const max = Math.max(0, this.detailLineCount - this.detailPageSize);
    this.detailScroll = Math.max(0, Math.min(max, this.detailScroll + delta));
    this.detailAutoFollow = this.detailScroll >= max;
    this.tui.requestRender();
  }

  private roster(width: number): string[] {
    if (!this.items.length) return [this.theme.fg("dim", "No tracked nodes")];
    const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.items.length - this.bodyHeight)));
    return this.items.slice(start, start + this.bodyHeight).map((item, offset) => {
      const index = start + offset;
      const marker = index === this.selected ? this.theme.fg("accent", "›") : " ";
      const agent = index === this.selected ? this.theme.bold(item.node.agent) : item.node.agent;
      const left = `${marker} ${item.branch} ${glyph(item.node.status, this.theme)} ${agent} ${this.theme.fg("dim", `· ${item.node.task.replace(/\s+/g, " ").trim()}`)}`;
      return rightAligned(left, this.theme.fg("dim", item.node.status), width);
    });
  }

  private detail(item: MeshTreeItem | undefined, width: number): Detail {
    if (!item) return { header: [], body: [this.theme.fg("dim", "No active or recent Mesh nodes."), "", this.theme.fg("dim", "New runs appear automatically while this inspector remains open.")] };
    const { run, node } = item;
    const now = Date.now();
    const stats = [node.model, tokens(node), node.activity?.toolUses ? `${node.activity.toolUses} tools` : "", node.activity?.turns ? `${node.activity.turns} turns` : "", elapsed(node.startedAt ?? run.createdAt, node.finishedAt, now)].filter(Boolean);
    const toolActivity = node.activity?.activeTools.length ? `tool: ${node.activity.activeTools.join(", ")}` : "";
    const thinking = node.activity?.thinkingText?.trim().replace(/\s+/g, " ").slice(-80);
    const response = node.activity?.responseText?.trim().replace(/\s+/g, " ").slice(-80);
    const activity = [toolActivity, thinking ? `thinking: ${thinking}` : "", !thinking && response ? `output: ${response}` : ""].filter(Boolean).join(" · ") || node.status;
    const header = [
      rightAligned(` ${glyph(node.status, this.theme)} ${this.theme.bold(node.agent)}`, this.theme.fg("dim", node.status), width),
      `  ${this.theme.fg("dim", `mesh · ${run.id.slice(0, 8)} · node ${node.id} · ${run.operator}`)}`,
      stats.length ? `  ${this.theme.fg("muted", stats.join(" · "))}` : "",
      `  ${this.theme.fg("dim", "Task")}  ${node.task.replace(/\s+/g, " ").trim()}`,
      `${this.theme.fg("accent", "Conversation")} ${this.theme.fg("dim", `· ${activity}`)}`,
    ].filter(Boolean).map((line) => truncateToWidth(line, width));

    const artifacts = [node.outputPath ? `Output: ${node.outputPath}` : "", node.attemptResultPath ? `Attempt: ${node.attemptResultPath}` : "", node.diagnosticPath ? `Diagnostic: ${node.diagnosticPath}` : ""].filter(Boolean);
    const raw = this.manager.conversation(run.id, node.id) || node.output || node.error || "";
    const body = artifacts.flatMap((line) => wrapTextWithAnsi(this.theme.fg("muted", line), width));
    if (artifacts.length && raw) body.push("");
    if (raw) body.push(...wrapTextWithAnsi(raw.slice(-128 * 1024), width));
    else if (node.status === "queued" || node.status === "paused") {
      const waiting = node.dependsOn.filter((id) => !["succeeded", "completed"].includes(run.nodes.find((candidate) => candidate.id === id)?.status ?? ""));
      body.push(this.theme.fg("dim", waiting.length ? `Waiting for: ${waiting.join(", ")}` : "Waiting to start."));
    } else body.push(this.theme.fg("dim", "(waiting for first message…)") );
    if (node.status === "running") {
      const current = node.activity?.activeTools.length ? node.activity.activeTools.join(", ") : node.activity?.responseText || "thinking…";
      body.push("", truncateToWidth(`${this.theme.fg("accent", "▍")} ${this.theme.fg("dim", current)}`, width));
    }
    return { header, body };
  }
}

export async function openMeshTree(ctx: ExtensionContext, manager: MeshManager): Promise<void> {
  if (ctx.mode !== "tui") return void ctx.ui.notify("Mesh tree requires Pi's TUI.", "warning");
  await ctx.ui.custom<undefined>(
    (tui, theme, keybindings, done) => new MeshTreeComponent(tui, theme, keybindings, manager, () => done(undefined)),
    { overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 } },
  );
}
