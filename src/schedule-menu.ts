import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentScheduler, ScheduledAgentJob } from "./scheduler.ts";

function relative(timestamp?: number): string {
  if (!timestamp) return "—";
  const diff = timestamp - Date.now();
  const future = diff > 0; const value = Math.abs(diff);
  if (value < 60_000) return future ? "in <1m" : "<1m ago";
  if (value < 3_600_000) { const minutes = Math.round(value / 60_000); return future ? `in ${minutes}m` : `${minutes}m ago`; }
  if (value < 86_400_000) { const hours = Math.round(value / 3_600_000); return future ? `in ${hours}h` : `${hours}h ago`; }
  const days = Math.round(value / 86_400_000); return future ? `in ${days}d` : `${days}d ago`;
}

function label(job: ScheduledAgentJob): string {
  return `${job.name.slice(0, 24)} · ${job.agent} · ${job.schedule} · next ${relative(job.nextRun)} · ${job.id}`;
}

export async function showSchedulesMenu(ctx: ExtensionCommandContext, scheduler?: AgentScheduler): Promise<void> {
  if (!scheduler) return void ctx.ui.notify("No scheduler is active in this session.", "info");
  const jobs = scheduler.list();
  if (!jobs.length) return void ctx.ui.notify("No scheduled jobs.", "info");
  const labels = jobs.map(label);
  const selected = await ctx.ui.select(`Scheduled jobs (${jobs.length}) — select to cancel`, labels);
  if (!selected) return;
  const job = jobs[labels.indexOf(selected)];
  if (!job) return;
  const details = [`Agent: ${job.agent}`, `Schedule: ${job.schedule} (${job.type})`, `Next run: ${job.nextRun ? new Date(job.nextRun).toISOString() : "cron"}`, `Prompt: ${job.prompt.slice(0, 300)}${job.prompt.length > 300 ? "…" : ""}`].join("\n");
  if (await ctx.ui.confirm(`Cancel \"${job.name}\"?`, details)) {
    scheduler.cancel(job.id);
    ctx.ui.notify(`Cancelled \"${job.name}\".`, "info");
  }
}
