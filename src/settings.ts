import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

export type BridgeTarget = { root: string; sessionId: string } & (
  { kind: "mesh"; runId: string; nodeId: string; attempt: number } |
  { kind: "direct"; id: string; generation: number }
);
export interface BridgeRoute {
  routeId: string;
  peerInstanceId: string;
  remoteRoute: string;
  localTarget: BridgeTarget;
  remoteTarget: BridgeTarget;
  mode: "store" | "active";
}
export interface BridgeSettings { enabled: boolean; routes: BridgeRoute[] }

export function bridgeTarget(value: unknown): BridgeTarget {
  const v = value as BridgeTarget;
  const id = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.root !== "string" || !path.isAbsolute(v.root) || v.root.length > 4096 || typeof v.sessionId !== "string" || !v.sessionId || v.sessionId.length > 512) throw new Error("Invalid bridge target root/sessionId");
  const keys = ["root", "sessionId", "kind", ...(v.kind === "mesh" ? ["runId", "nodeId", "attempt"] : ["id", "generation"])];
  if (Object.keys(v).some(k => !keys.includes(k))) throw new Error("Unknown bridge target field");
  if (v.kind === "mesh" && id(v.runId) && id(v.nodeId) && v.nodeId.length <= 64 && Number.isSafeInteger(v.attempt) && v.attempt >= 0) return { root: v.root, sessionId: v.sessionId, kind: v.kind, runId: v.runId, nodeId: v.nodeId, attempt: v.attempt };
  if (v.kind === "direct" && id(v.id) && Number.isSafeInteger(v.generation) && v.generation >= 1) return { root: v.root, sessionId: v.sessionId, kind: v.kind, id: v.id, generation: v.generation };
  throw new Error("Invalid exact bridge target/attempt/generation");
}
function bridgeSettings(value: unknown): BridgeSettings {
  const v = value as BridgeSettings;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["enabled", "routes"].includes(k)) || (v.enabled !== undefined && typeof v.enabled !== "boolean") || (v.routes !== undefined && (!Array.isArray(v.routes) || v.routes.length > 16))) throw new Error("Invalid bridge settings (maximum 16 routes)");
  const routes = (v.routes ?? []).map(r => {
    if (!r || typeof r !== "object" || Object.keys(r).some(k => !["routeId", "peerInstanceId", "remoteRoute", "localTarget", "remoteTarget", "mode"].includes(k)) || typeof r.routeId !== "string" || typeof r.remoteRoute !== "string" || typeof r.peerInstanceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.routeId) || !/^[A-Za-z0-9_-]{1,64}$/.test(r.remoteRoute) || !/^[0-9a-f]{32}$/.test(r.peerInstanceId) || (r.mode !== undefined && !["store", "active"].includes(r.mode))) throw new Error("Invalid fixed bridge route");
    return { routeId: r.routeId, peerInstanceId: r.peerInstanceId, remoteRoute: r.remoteRoute, localTarget: bridgeTarget(r.localTarget), remoteTarget: bridgeTarget(r.remoteTarget), mode: r.mode ?? "store" };
  });
  if (new Set(routes.map(r => r.routeId)).size !== routes.length) throw new Error("Duplicate bridge routeId");
  return { enabled: v.enabled ?? false, routes };
}

export interface MeshSettings {
  bridge: BridgeSettings;
  maxAgentDepth: number;
  maxConcurrentAgents: number;
  maxNodes: number;
  defaultNodeTimeoutMs: number;
  messagePayloadMaxBytes: number;
  recipientUnreadMaxBytes: number;
  childExtensions: Record<string, string>;
  childSkills: Record<string, string>;
  joinMode: "async" | "group" | "smart";
  directCommunication: boolean;
  mailboxNotifications: boolean;
  debug: boolean;
  retentionDays: number;
  maxTerminalRuns: number;
  debugMaxBytes: number;
}

export const defaultMeshSettings: MeshSettings = {
  bridge: { enabled: false, routes: [] },
  maxAgentDepth: 8,
  maxConcurrentAgents: 8,
  maxNodes: 128,
  defaultNodeTimeoutMs: 30 * 60 * 1000,
  messagePayloadMaxBytes: 32 * 1024,
  recipientUnreadMaxBytes: 1024 * 1024,
  childExtensions: {},
  childSkills: {},
  joinMode: "smart",
  directCommunication: false,
  mailboxNotifications: false,
  debug: false,
  retentionDays: 30,
  maxTerminalRuns: 100,
  debugMaxBytes: 4 * 1024 * 1024,
};

export function meshSettingsFiles(cwd: string, env: NodeJS.ProcessEnv = process.env, includeProject = true): string[] {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
  const files = [path.join(agentDir, "mesh", "settings.yaml")];
  if (includeProject) files.push(path.join(cwd, CONFIG_DIR_NAME, "mesh", "settings.yaml"));
  return files;
}

function resolvePathMap(value: unknown, file: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, target]) => [name, typeof target === "string" ? path.resolve(path.dirname(file), target) : target]));
}

function readSettings(file: string, userLayer: boolean): Partial<MeshSettings> {
  let source: string;
  try { source = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  let value: unknown;
  try { value = parse(source); }
  catch (error) { throw new Error(`Invalid mesh settings ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  if (value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid mesh settings ${file}: expected a mapping`);
  const record = value as Record<string, unknown>;
  // Project trust is not permission to edit Host bridge authorization.
  if (!userLayer) delete record.bridge;
  else if (record.bridge !== undefined) record.bridge = bridgeSettings(record.bridge);
  if (record.childExtensions !== undefined) record.childExtensions = resolvePathMap(record.childExtensions, file);
  if (record.childSkills !== undefined) record.childSkills = resolvePathMap(record.childSkills, file);
  const allowed = new Set(["bridge", "maxAgentDepth", "maxConcurrentAgents", "maxNodes", "defaultNodeTimeoutMs", "messagePayloadMaxBytes", "recipientUnreadMaxBytes", "childExtensions", "childSkills", "joinMode", "directCommunication", "mailboxNotifications", "debug", "retentionDays", "maxTerminalRuns", "debugMaxBytes"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Invalid mesh settings ${file}: unknown key ${key}`);
  const integer = (key: keyof MeshSettings, min: number, max: number) => {
    const item = record[key];
    if (item === undefined) return;
    if (!Number.isInteger(item) || (item as number) < min || (item as number) > max) throw new Error(`Invalid mesh settings ${file}: ${key} must be ${min}-${max}`);
  };
  integer("maxAgentDepth", 1, 32);
  integer("maxConcurrentAgents", 1, 32);
  integer("maxNodes", 1, 128);
  integer("defaultNodeTimeoutMs", 100, 3_600_000);
  integer("messagePayloadMaxBytes", 1, 1024 * 1024);
  integer("recipientUnreadMaxBytes", 1, 64 * 1024 * 1024);
  integer("retentionDays", 1, 3650);
  integer("maxTerminalRuns", 1, 10_000);
  integer("debugMaxBytes", 1024, 1024 * 1024 * 1024);
  const paths = (key: "childExtensions" | "childSkills") => {
    const item = record[key];
    if (item === undefined) return;
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.entries(item).some(([name, value]) => !/^[A-Za-z0-9._-]{1,128}$/.test(name) || typeof value !== "string" || !value.trim())) throw new Error(`Invalid mesh settings ${file}: ${key} must map names to paths`);
  };
  paths("childExtensions"); paths("childSkills");
  if (record.joinMode !== undefined && !["async", "group", "smart"].includes(record.joinMode as string)) throw new Error(`Invalid mesh settings ${file}: joinMode must be async, group, or smart`);
  if (record.directCommunication !== undefined && typeof record.directCommunication !== "boolean") throw new Error(`Invalid mesh settings ${file}: directCommunication must be boolean`);
  if (record.mailboxNotifications !== undefined && typeof record.mailboxNotifications !== "boolean") throw new Error(`Invalid mesh settings ${file}: mailboxNotifications must be boolean`);
  if (record.debug !== undefined && typeof record.debug !== "boolean") throw new Error(`Invalid mesh settings ${file}: debug must be boolean`);
  return record as Partial<MeshSettings>;
}

export function loadMeshSettings(cwd: string, env: NodeJS.ProcessEnv = process.env, includeProject = true): MeshSettings {
  return meshSettingsFiles(cwd, env, includeProject).reduce((settings, file, index) => ({ ...settings, ...readSettings(file, index === 0) }), { ...defaultMeshSettings });
}
