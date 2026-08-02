import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { meshDir } from "./store.ts";

export interface RunLeaseOwner {
  version: 1;
  token: string;
  runId: string;
  pid: number;
  hostname: string;
  processStartIdentity?: string;
  acquiredAt: number;
}

export interface RunLease {
  owner: RunLeaseOwner;
  release(): boolean;
}

export class RunLeaseConflictError extends Error {
  readonly owner?: RunLeaseOwner;

  constructor(message: string, owner?: RunLeaseOwner) {
    super(message);
    this.name = "RunLeaseConflictError";
    this.owner = owner;
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : undefined;
    } catch { return undefined; }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim() ? `${process.platform}:${result.stdout.trim()}` : undefined;
  }
  return undefined;
}

function processAlive(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? false : code === "EPERM" ? true : undefined;
  }
}

function parseOwner(value: unknown): RunLeaseOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = value as Partial<RunLeaseOwner>;
  if (owner.version !== 1 || typeof owner.token !== "string" || typeof owner.runId !== "string"
    || !Number.isInteger(owner.pid) || (owner.pid ?? 0) < 1 || typeof owner.hostname !== "string"
    || typeof owner.acquiredAt !== "number"
    || (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string")) return undefined;
  return owner as RunLeaseOwner;
}

function readOwner(dir: string): RunLeaseOwner | undefined {
  try { return parseOwner(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"))); }
  catch { return undefined; }
}

function stale(owner: RunLeaseOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  const alive = processAlive(owner.pid);
  if (alive === false) return true;
  if (alive !== true || !owner.processStartIdentity || owner.processStartIdentity.startsWith("runtime:")) return false;
  const current = processStartIdentity(owner.pid);
  return current !== undefined && current.split(":", 1)[0] === owner.processStartIdentity.split(":", 1)[0] && current !== owner.processStartIdentity;
}

function createLease(dir: string, owner: RunLeaseOwner): boolean {
  const candidate = `${dir}.candidate-${owner.token}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  fs.rmSync(candidate, { recursive: true, force: true });
  fs.mkdirSync(candidate, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(candidate, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
    try { fs.renameSync(candidate, dir); return true; }
    catch (error) { if (fs.existsSync(dir)) return false; throw error; }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}

export function acquireRunLease(cwd: string, runId: string): RunLease {
  const dir = path.join(meshDir(cwd), "leases", runId);
  const identity = processStartIdentity(process.pid) ?? `runtime:${Math.round(Date.now() - process.uptime() * 1000)}`;
  const owner: RunLeaseOwner = {
    version: 1, token: randomUUID(), runId, pid: process.pid, hostname: os.hostname(),
    processStartIdentity: identity, acquiredAt: Date.now(),
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    if (createLease(dir, owner)) return {
      owner,
      release() {
        if (readOwner(dir)?.token !== owner.token) return false;
        fs.rmSync(dir, { recursive: true, force: true });
        return !fs.existsSync(dir);
      },
    };
    const existing = readOwner(dir);
    if (!existing || !stale(existing)) {
      const detail = existing ? `pid ${existing.pid} on ${existing.hostname}` : "unreadable owner metadata";
      throw new RunLeaseConflictError(`Mesh run ${runId} is already owned (${detail}).`, existing);
    }
    const tombstone = `${dir}.stale-${existing.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
    try { fs.renameSync(dir, tombstone); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || fs.existsSync(tombstone)) continue;
      throw error;
    }
  }
  throw new RunLeaseConflictError(`Could not acquire mesh run ${runId}.`, readOwner(dir));
}
