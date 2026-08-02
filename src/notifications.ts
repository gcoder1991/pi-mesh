import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionAgentRecord } from "./session-agents.ts";
import type { MeshSettings } from "./settings.ts";

export class CompletionNotifier {
  private readonly pi: ExtensionAPI;
  private readonly settings: MeshSettings;
  private readonly pending: SessionAgentRecord[] = [];
  private readonly delivered = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(pi: ExtensionAPI, settings: MeshSettings) { this.pi = pi; this.settings = settings; }
  enqueue(record: SessionAgentRecord, format: (record: SessionAgentRecord) => string): void {
    if (this.delivered.has(record.id)) return;
    this.pending.push(record);
    if (this.settings.joinMode === "async") return this.flush(format);
    if (!this.timer) { this.timer = setTimeout(() => this.flush(format), this.settings.joinMode === "group" ? 250 : 100); this.timer.unref?.(); }
  }
  flush(format: (record: SessionAgentRecord) => string): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const records = this.pending.splice(0).filter((record) => !this.delivered.has(record.id));
    if (!records.length) return;
    for (const record of records) this.delivered.add(record.id);
    this.pi.sendMessage({ customType: "subagent-notification", content: records.map(format).join("\n\n---\n\n"), display: true, details: { ids: records.map((record) => record.id) } }, { deliverAs: "followUp", triggerTurn: true });
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending.length = 0; }
}
