// Adapted from @tintinweb/pi-subagents (MIT) for pi-mesh's unified Direct Agent + Mesh record model.
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface ConversationRecord {
  id: string;
  agent: string;
  description: string;
  status: string;
  createdAt: number;
  completedAt?: number;
  maxTurns?: number;
  turns?: number;
  toolUses?: number;
  tokens?: number;
  activeTools?: string[];
  responseText?: string;
  thinkingText?: string;
  conversation(): string;
}

export interface ViewerKeybindings {
  matches(data: string, keybinding: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown" | "tui.select.cancel"): boolean;
}

const key = (bindings: ViewerKeybindings | undefined, data: string, id: Parameters<ViewerKeybindings["matches"]>[1], fallback: string): boolean => bindings ? bindings.matches(data, id) : matchesKey(data, fallback as any);
const statusIcon = (status: string): string => status === "running" ? "●" : status === "completed" || status === "succeeded" ? "✓" : status === "failed" ? "✗" : status === "queued" || status === "paused" ? "◦" : "■";
const compactTokens = (count: number): string => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);

export class ConversationViewer {
  private scroll = 0;
  private autoScroll = true;
  private stopArmed = false;
  private composer?: Input;
  private disposed = false;
  private width = 80;
  private readonly timer: NodeJS.Timeout;
  private readonly tui: any;
  private readonly theme: Theme;
  private readonly keybindings: ViewerKeybindings | undefined;
  private readonly current: () => ConversationRecord | undefined;
  private readonly done: () => void;
  private readonly stop: () => void;
  private readonly steer: (message: string) => void;

  constructor(
    tui: any,
    theme: Theme,
    keybindings: ViewerKeybindings | undefined,
    current: () => ConversationRecord | undefined,
    done: () => void,
    stop: () => void,
    steer: (message: string) => void,
  ) {
    this.tui = tui; this.theme = theme; this.keybindings = keybindings; this.current = current; this.done = done; this.stop = stop; this.steer = steer;
    this.timer = setInterval(() => { if (!this.disposed) this.tui.requestRender(); }, 250);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    if (this.composer) { this.composer.handleInput(data); this.tui.requestRender(); return; }
    if (key(this.keybindings, data, "tui.select.cancel", "escape") || matchesKey(data, "q")) return this.done();
    const record = this.current();
    if (!record) return this.done();
    if (!["running", "queued", "paused"].includes(record.status)) this.stopArmed = false;
    if (matchesKey(data, "enter") && record.status === "running") { this.stopArmed = false; this.openComposer(); return; }
    if (matchesKey(data, "x")) {
      if (["running", "queued", "paused"].includes(record.status)) {
        if (this.stopArmed) { this.stopArmed = false; this.stop(); } else this.stopArmed = true;
        this.tui.requestRender();
      }
      return;
    }
    this.stopArmed = false;
    const lines = this.content(record, Math.max(1, this.width - 4));
    const viewport = this.viewportHeight();
    const max = Math.max(0, lines.length - viewport);
    if (key(this.keybindings, data, "tui.select.up", "up") || matchesKey(data, "k")) { this.scroll = Math.max(0, this.scroll - 1); this.autoScroll = this.scroll >= max; }
    else if (key(this.keybindings, data, "tui.select.down", "down") || matchesKey(data, "j")) { this.scroll = Math.min(max, this.scroll + 1); this.autoScroll = this.scroll >= max; }
    else if (key(this.keybindings, data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up")) { this.scroll = Math.max(0, this.scroll - viewport); this.autoScroll = false; }
    else if (key(this.keybindings, data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down")) { this.scroll = Math.min(max, this.scroll + viewport); this.autoScroll = this.scroll >= max; }
    else if (matchesKey(data, "home")) { this.scroll = 0; this.autoScroll = false; }
    else if (matchesKey(data, "end")) { this.scroll = max; this.autoScroll = true; }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 6) return [];
    this.width = width;
    const record = this.current();
    if (!record) return [];
    const inner = width - 4;
    const row = (content: string) => {
      const truncated = truncateToWidth(content, inner, "…", true);
      return this.theme.fg("border", "│") + " " + truncated + " ".repeat(Math.max(1, inner - visibleWidth(truncated) + 1)) + this.theme.fg("border", "│");
    };
    const top = this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const bottom = this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const separator = row(this.theme.fg("dim", "─".repeat(inner)));
    const elapsed = `${Math.max(0, Math.round(((record.completedAt ?? Date.now()) - record.createdAt) / 1000))}s`;
    const stats = [record.turns ? `↻${record.turns}${record.maxTurns ? `≤${record.maxTurns}` : ""}` : "", record.toolUses ? `${record.toolUses} tools` : "", record.tokens ? `${compactTokens(record.tokens)} tokens` : "", elapsed].filter(Boolean).join(" · ");
    const content = this.content(record, inner);
    const viewport = this.viewportHeight();
    const max = Math.max(0, content.length - viewport);
    if (this.autoScroll) this.scroll = max;
    this.scroll = Math.min(this.scroll, max);
    const visible = content.slice(this.scroll, this.scroll + viewport);
    const lines = [top, row(`${statusIcon(record.status)} ${this.theme.bold(record.agent)}  ${this.theme.fg("muted", record.description)} ${this.theme.fg("dim", `· ${stats}`)}`), separator];
    for (let index = 0; index < viewport; index++) lines.push(row(visible[index] ?? ""));
    lines.push(separator);
    if (this.composer) {
      lines.push(row(this.composer.render(inner)[0] ?? ""));
      lines.push(row(`${this.theme.fg("accent", "✎ steer")} ${this.theme.fg("dim", "Enter send · Esc cancel")}`));
    } else {
      const actions = [record.status === "running" ? "Enter steer" : "", ["running", "queued", "paused"].includes(record.status) ? (this.stopArmed ? "x again to STOP" : "x stop") : "", "↑↓/j/k scroll · PgUp/PgDn · Home/End · Esc close"].filter(Boolean).join(" · ");
      lines.push(row(this.stopArmed ? this.theme.fg("error", actions) : this.theme.fg("dim", actions)));
    }
    lines.push(bottom);
    return lines;
  }

  invalidate(): void {}
  dispose(): void { this.disposed = true; clearInterval(this.timer); }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => { const message = value.trim(); this.composer = undefined; if (message) this.steer(message); this.tui.requestRender(); };
    input.onEscape = () => { this.composer = undefined; this.tui.requestRender(); };
    this.composer = input;
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 30;
    return Math.max(3, Math.floor(rows * 0.7) - (this.composer ? 8 : 7));
  }

  private content(record: ConversationRecord, width: number): string[] {
    const text = record.conversation().trim();
    const lines = text ? wrapTextWithAnsi(text, width) : [this.theme.fg("dim", "(waiting for first message…)")];
    if (record.status === "running") {
      const tools = record.activeTools?.length ? `tool: ${record.activeTools.join(", ")}` : "";
      const thinking = record.thinkingText?.trim().replace(/\s+/g, " ").slice(-80);
      const output = record.responseText?.trim().replace(/\s+/g, " ").slice(-80);
      const activity = [tools, thinking ? `thinking: ${thinking}` : "", !thinking && output ? `output: ${output}` : ""].filter(Boolean).join(" · ") || "thinking…";
      lines.push("", truncateToWidth(`${this.theme.fg("accent", "▍")} ${this.theme.fg("dim", activity)}`, width));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }
}
