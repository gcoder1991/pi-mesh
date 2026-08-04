import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MeshNode, MeshRun } from "./manager.ts";
import { atomicWrite, listRunFiles, meshDir, readJson } from "./store.ts";

export type HerdrTreeAction = "open" | "status" | "close";

type ExecResult = { stdout: string; stderr: string; code: number | null };
type RunHerdr = (args: string[]) => Promise<ExecResult>;

type Binding = { schema: "pi-mesh.herdr-tree/v1"; paneId: string; cwd: string; openedAt: string; command: string };

const ACTIVE_RUNS = new Set(["running", "paused", "cancelling"]);
const ACTIVE_NODES = new Set(["queued", "running", "paused"]);
const RECENT_RUN_MS = 20_000;

function glyph(status: string): string {
  if (status === "running") return "●";
  if (status === "queued") return "◦";
  if (status === "paused") return "Ⅱ";
  if (status === "succeeded" || status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "cancelled") return "⊘";
  if (status === "skipped") return "–";
  return "■";
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
  return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M tok` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k tok` : `${count} tok`;
}

function compact(text: string | undefined, width = 100): string {
  const value = text?.trim().replace(/\s+/g, " ") ?? "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function nodeTree(run: MeshRun, now: number): string[] {
  const nodes = new Map(run.nodes.map((node) => [node.id, node]));
  const children = new Map<string, MeshNode[]>();
  const roots: MeshNode[] = [];
  for (const node of run.nodes) {
    const parent = node.dependsOn.find((id) => nodes.has(id));
    if (!parent) roots.push(node);
    else children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const render = (node: MeshNode, prefix: string, last: boolean): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const branch = last ? "└─" : "├─";
    const waiting = node.dependsOn.filter((id) => !["succeeded", "completed"].includes(nodes.get(id)?.status ?? ""));
    const extraParents = node.dependsOn.slice(1);
    const stats = [node.status, elapsed(node.startedAt, node.finishedAt, now), tokens(node), extraParents.length ? `also:${extraParents.join(",")}` : "", waiting.length ? `wait:${waiting.join(",")}` : ""].filter(Boolean).join(" · ");
    lines.push(`${prefix}${branch} ${glyph(node.status)} ${node.id} · ${node.agent} · ${stats}`);
    if (node.task) lines.push(`${prefix}${last ? "   " : "│  "}   ${compact(node.task)}`);
    const activity = node.activity?.activeTools.length ? node.activity.activeTools.join(", ") : node.activity?.responseText || node.output || node.error;
    if (activity) lines.push(`${prefix}${last ? "   " : "│  "}   ⎿ ${compact(activity)}`);
    const nested = children.get(node.id) ?? [];
    nested.forEach((child, index) => render(child, `${prefix}${last ? "   " : "│  "}`, index === nested.length - 1));
  };
  roots.forEach((node, index) => render(node, "  ", index === roots.length - 1));
  for (const node of run.nodes) if (!seen.has(node.id)) render(node, "  ", true);
  return lines;
}

export function formatMeshTree(runs: MeshRun[], now = Date.now()): string {
  const ordered = runs.filter((run) => ACTIVE_RUNS.has(run.status) || now - (run.finishedAt ?? run.updatedAt) < RECENT_RUN_MS)
    .sort((a, b) => Number(ACTIVE_RUNS.has(b.status)) - Number(ACTIVE_RUNS.has(a.status)) || b.updatedAt - a.updatedAt);
  const active = ordered.flatMap((run) => run.nodes).filter((node) => ACTIVE_NODES.has(node.status)).length;
  const lines = [`PI-MESH TREE  ${active ? `● ${active} active` : "○ idle"}`, "Astralink-style run → dependency tree; closing this pane does not stop Mesh runs.", ""];
  if (!ordered.length) return [...lines, "No Mesh runs in this project."].join("\n");
  for (const run of ordered) {
    const done = run.nodes.filter((node) => ["succeeded", "failed", "cancelled", "skipped"].includes(node.status)).length;
    lines.push(`▼ ${run.id} · ${run.operator} · ${run.status} · ${done}/${run.nodes.length} done · ${elapsed(run.createdAt, run.finishedAt, now)}`);
    lines.push(...nodeTree(run, now), "");
  }
  return lines.join("\n").trimEnd();
}

function bindingFile(cwd: string): string { return path.join(meshDir(cwd), "herdr-tree.json"); }
function readBinding(cwd: string): Binding | undefined {
  try {
    const value = readJson<Binding>(bindingFile(cwd));
    return value?.schema === "pi-mesh.herdr-tree/v1" && value.cwd === cwd && value.paneId ? value : undefined;
  } catch { return undefined; }
}

function paneId(stdout: string): string | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as any;
      const pane = value?.pane ?? value;
      const id = pane?.pane_id ?? pane?.paneId ?? pane?.id;
      if (typeof id === "string" && id) return id;
    } catch {}
  }
  return undefined;
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

function runnerCommand(cwd: string): string {
  const runner = fileURLToPath(new URL("./herdr-tree.ts", import.meta.url));
  return [process.execPath, "--experimental-strip-types", runner, "--runner", "--cwd", cwd].map(shellQuote).join(" ");
}

function failure(result: ExecResult): string { return compact(result.stderr || result.stdout || `Herdr exited with code ${result.code}`, 300); }

export async function manageHerdrTree(action: HerdrTreeAction, cwd: string, runHerdr: RunHerdr): Promise<{ ok: boolean; message: string }> {
  const root = fs.realpathSync(path.resolve(cwd));
  const existing = readBinding(root);
  if (action === "status") {
    if (!existing) return { ok: true, message: "Mesh tree pane is not open." };
    const result = await runHerdr(["pane", "get", existing.paneId]);
    return result.code === 0 ? { ok: true, message: `Mesh tree pane ${existing.paneId} is open.` } : { ok: false, message: `Mesh tree pane ${existing.paneId} is unavailable: ${failure(result)}` };
  }
  if (action === "close") {
    if (!existing) return { ok: true, message: "Mesh tree pane is not open." };
    const result = await runHerdr(["pane", "close", existing.paneId]);
    if (result.code !== 0 && !/not.?found|gone|no_such_pane/i.test(`${result.stderr}\n${result.stdout}`)) return { ok: false, message: `Failed to close Mesh tree pane: ${failure(result)}` };
    fs.rmSync(bindingFile(root), { force: true });
    return { ok: true, message: `Closed Mesh tree pane ${existing.paneId}; Mesh runs were not stopped.` };
  }
  if (existing) {
    const live = await runHerdr(["pane", "get", existing.paneId]);
    if (live.code === 0) return { ok: true, message: `Mesh tree pane ${existing.paneId} is already open.` };
  }
  const split = await runHerdr(["pane", "split", "--current", "--direction", "left", "--cwd", root, "--focus"]);
  if (split.code !== 0) return { ok: false, message: `Failed to open Herdr left pane: ${failure(split)}` };
  const id = paneId(split.stdout);
  if (!id) return { ok: false, message: "Herdr pane split returned no pane id." };
  const command = runnerCommand(root);
  const started = await runHerdr(["pane", "run", id, command]);
  if (started.code !== 0) {
    await runHerdr(["pane", "close", id]);
    return { ok: false, message: `Failed to start Mesh tree: ${failure(started)}` };
  }
  atomicWrite(bindingFile(root), { schema: "pi-mesh.herdr-tree/v1", paneId: id, cwd: root, openedAt: new Date().toISOString(), command } satisfies Binding);
  return { ok: true, message: `Opened Astralink-style Mesh tree in Herdr left pane ${id}.` };
}

function loadRuns(cwd: string): MeshRun[] {
  const runs: MeshRun[] = [];
  for (const file of listRunFiles(cwd)) {
    try {
      const run = readJson<MeshRun>(file);
      if (run?.id && Array.isArray(run.nodes)) runs.push(run);
    } catch {}
  }
  return runs;
}

export function runHerdrTree(argv = process.argv.slice(2)): void {
  const cwdIndex = argv.indexOf("--cwd");
  const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : undefined;
  if (!argv.includes("--runner") || !cwd) throw new Error("Mesh tree runner requires --runner --cwd <project>.");
  const render = () => process.stdout.write(`\x1b[2J\x1b[H${formatMeshTree(loadRuns(cwd))}\n`);
  render();
  const timer = setInterval(render, 500);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.argv.includes("--runner")) {
  try { runHerdrTree(); } catch (error) { process.stderr.write(`Mesh tree failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
