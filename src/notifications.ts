import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionAgentRecord } from "./session-agents.ts";
import type { MeshSettings } from "./settings.ts";

export class CompletionNotifier {
  private readonly pi: ExtensionAPI;
  private readonly settings: MeshSettings;
  private readonly pending: Array<{ id: string; content: string }> = [];
  private readonly delivered = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(pi: ExtensionAPI, settings: MeshSettings) { this.pi = pi; this.settings = settings; }
  enqueue(record: SessionAgentRecord, format: (record: SessionAgentRecord) => string): void {
    this.enqueueMessage(record.id, format(record));
  }
  enqueueMessage(id: string, content: string): void {
    if (this.delivered.has(id)) return;
    this.pending.push({ id, content });
    if (this.settings.joinMode === "async") return this.flush();
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), this.settings.joinMode === "group" ? 250 : 100); this.timer.unref?.(); }
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const records = this.pending.splice(0).filter((record) => !this.delivered.has(record.id));
    if (!records.length) return;
    for (const record of records) this.delivered.add(record.id);
    this.pi.sendMessage({ customType: "subagent-notification", content: records.map((record) => record.content).join("\n\n---\n\n"), display: true, details: { ids: records.map((record) => record.id) } }, { deliverAs: "followUp", triggerTurn: true });
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending.length = 0; }
}
