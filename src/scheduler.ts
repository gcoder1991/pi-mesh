import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { atomicWrite, readJson } from "./store.ts";

export interface ScheduledAgentJob {
  id: string; name: string; schedule: string; prompt: string; agent: string; createdAt: number; nextRun?: number; type: "once" | "interval" | "cron";
  model?: string; thinking?: string; maxTurns?: number; persistent?: boolean; transcript?: boolean; sessionDir?: string;
}

function parse(value: string): { type: ScheduledAgentJob["type"]; delay?: number; cron?: string; repeat?: boolean } {
  const relative = value.match(/^(\+?)(\d+)(s|m|h|d)$/);
  if (relative) {
    const delay = Number(relative[2]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[relative[3] as "s" | "m" | "h" | "d"];
    return { type: relative[1] ? "once" : "interval", delay, repeat: !relative[1] };
  }
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp) && timestamp > Date.now()) return { type: "once", delay: timestamp - Date.now() };
  if (value.trim().split(/\s+/).length === 6) return { type: "cron", cron: value };
  throw new Error("schedule must be six-field cron, interval 5m/1h, one-shot +10m, or a future ISO timestamp");
}

export class AgentScheduler {
  private readonly file: string;
  private readonly jobs = new Map<string, ScheduledAgentJob>();
  private readonly timers = new Map<string, NodeJS.Timeout | Cron>();
  private readonly fire: (job: ScheduledAgentJob) => void | Promise<void>;
  constructor(cwd: string, sessionId: string, fire: (job: ScheduledAgentJob) => void | Promise<void>) {
    this.file = path.join(cwd, CONFIG_DIR_NAME, "mesh", "schedules", `${sessionId}.json`); this.fire = fire; this.restore();
  }
  add(input: Omit<ScheduledAgentJob, "id" | "createdAt" | "type" | "nextRun">): ScheduledAgentJob {
    if (this.jobs.size >= 256) throw new Error("Schedule limit reached (256 jobs per session)");
    if (!input.name.trim() || Buffer.byteLength(input.name, "utf8") > 1024 || !input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 256 * 1024 || !/^[A-Za-z0-9._-]{1,64}$/.test(input.agent)) throw new Error("Invalid scheduled agent job");
    const spec = parse(input.schedule); const job: ScheduledAgentJob = { ...input, id: crypto.randomUUID(), createdAt: Date.now(), type: spec.type };
    this.jobs.set(job.id, job); this.arm(job, spec); this.persist(); return job;
  }
  list(): ScheduledAgentJob[] { return [...this.jobs.values()].sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity)); }
  cancel(id: string): boolean { const job = this.jobs.get(id); if (!job) return false; this.stopTimer(id); this.jobs.delete(id); this.persist(); return true; }
  dispose(): void { for (const id of this.timers.keys()) this.stopTimer(id); }
  private emit(job: ScheduledAgentJob): void { Promise.resolve().then(() => this.fire(job)).catch(() => {}); }
  private arm(job: ScheduledAgentJob, spec = parse(job.schedule), restore = false): void {
    this.stopTimer(job.id);
    if (spec.type === "cron") {
      const cron = new Cron(spec.cron!, { protect: true }, () => this.emit(job)); job.nextRun = cron.nextRun()?.getTime(); this.timers.set(job.id, cron);
    } else {
      const now = Date.now();
      const firstRun = restore && job.nextRun ? job.nextRun : now + spec.delay!;
      if (spec.repeat) {
        job.nextRun ??= firstRun;
        while (job.nextRun <= now) job.nextRun += spec.delay!;
      } else job.nextRun = firstRun;
      const run = () => {
        this.emit(job);
        if (spec.repeat) {
          job.nextRun = (job.nextRun ?? Date.now()) + spec.delay!;
          while (job.nextRun <= Date.now()) job.nextRun += spec.delay!;
          const timer = setTimeout(run, Math.max(0, job.nextRun - Date.now())); timer.unref?.(); this.timers.set(job.id, timer); this.persist();
        } else { this.jobs.delete(job.id); this.timers.delete(job.id); this.persist(); }
      };
      const timer = setTimeout(run, Math.max(0, (job.nextRun ?? firstRun) - Date.now())); timer.unref?.(); this.timers.set(job.id, timer);
    }
  }
  private stopTimer(id: string): void { const timer = this.timers.get(id); if (timer instanceof Cron) timer.stop(); else if (timer) clearTimeout(timer); this.timers.delete(id); }
  private persist(): void { atomicWrite(this.file, this.list()); }
  private restore(): void {
    const jobs = readJson<ScheduledAgentJob[]>(this.file) ?? [];
    if (!Array.isArray(jobs) || jobs.length > 256) throw new Error(`Invalid schedule registry ${this.file}: expected at most 256 jobs`);
    for (const job of jobs) {
      if (!job || typeof job.id !== "string" || typeof job.name !== "string" || typeof job.schedule !== "string" || typeof job.prompt !== "string" || typeof job.agent !== "string" || typeof job.createdAt !== "number" || (job.nextRun !== undefined && (typeof job.nextRun !== "number" || !Number.isFinite(job.nextRun))) || !["once", "interval", "cron"].includes(job.type)) throw new Error(`Invalid schedule registry ${this.file}: malformed job`);
      let spec: ReturnType<typeof parse>;
      try { spec = job.type === "once" && job.nextRun ? { type: "once" as const, delay: job.nextRun - Date.now() } : parse(job.schedule); }
      catch (error) { throw new Error(`Invalid schedule registry ${this.file}: ${error instanceof Error ? error.message : String(error)}`); }
      if (spec.type !== job.type) throw new Error(`Invalid schedule registry ${this.file}: schedule type does not match job type`);
      if (spec.type === "once" && job.nextRun && job.nextRun <= Date.now()) continue;
      this.jobs.set(job.id, job); this.arm(job, spec, true);
    }
    this.persist();
  }
}
