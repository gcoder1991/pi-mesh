import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionAgentRecord } from "./session-agents.ts";
import type { MeshSettings } from "./settings.ts";

export class CompletionNotifier {
  private readonly pi: ExtensionAPI;
  private readonly settings: MeshSettings;
  private readonly pending: Array<{ id: string; content: string; direct?: boolean; authorize?: (details: object) => void | string }> = [];
  private readonly directGenerations = new Map<string, number>();
  private readonly delivered = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(pi: ExtensionAPI, settings: MeshSettings) { this.pi = pi; this.settings = settings; }
  enqueue(record: SessionAgentRecord, format: (record: SessionAgentRecord) => string): void {
    if (record.foreground) return;
    const generation = record.generation ?? 0;
    if ((this.directGenerations.get(record.id) ?? -1) >= generation) return;
    this.directGenerations.set(record.id, generation);
    this.enqueueMessage(`${record.id}:${generation}`, format(record), true);
  }
  enqueueMessage(id: string, content: string, direct = false, authorize?: (details: object) => void | string): void {
    if (this.delivered.has(id) || this.pending.some((record) => record.id === id)) return;
    this.pending.push({ id, content, direct, authorize });
    if (this.settings.joinMode === "async") return this.flush();
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), this.settings.joinMode === "group" ? 250 : 100); this.timer.unref?.(); }
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const records = this.pending.splice(0).filter((record) => record.direct || !this.delivered.has(record.id));
    if (!records.length) return;
    for (const record of records) if (!record.direct) this.delivered.add(record.id);
    const details = { ids: records.map((record) => record.id) };
    const content = records.map((record) => { const suffix = record.authorize?.(details); return record.content + (typeof suffix === "string" ? suffix : ""); }).join("\n\n---\n\n");
    this.pi.sendMessage({ customType: "subagent-notification", content, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending.length = 0; }
}
