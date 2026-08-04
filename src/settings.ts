import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";

export interface MeshSettings {
  maxAgentDepth: number;
  maxConcurrentAgents: number;
  maxNodes: number;
  messagePayloadMaxBytes: number;
  recipientUnreadMaxBytes: number;
  childExtensions: Record<string, string>;
  childSkills: Record<string, string>;
  joinMode: "async" | "group" | "smart";
  debug: boolean;
  retentionDays: number;
  maxTerminalRuns: number;
  debugMaxBytes: number;
}

export const defaultMeshSettings: MeshSettings = {
  maxAgentDepth: 8,
  maxConcurrentAgents: 8,
  maxNodes: 128,
  messagePayloadMaxBytes: 32 * 1024,
  recipientUnreadMaxBytes: 1024 * 1024,
  childExtensions: {},
  childSkills: {},
  joinMode: "smart",
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

function readSettings(file: string): Partial<MeshSettings> {
  let source: string;
  try { source = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  let value: unknown;
  try { value = parse(source); }
  catch (error) { throw new Error(`Invalid mesh settings ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  if (value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid mesh settings ${file}: expected a mapping`);
  const record = value as Record<string, unknown>;
  if (record.childExtensions !== undefined) record.childExtensions = resolvePathMap(record.childExtensions, file);
  if (record.childSkills !== undefined) record.childSkills = resolvePathMap(record.childSkills, file);
  const allowed = new Set(["maxAgentDepth", "maxConcurrentAgents", "maxNodes", "messagePayloadMaxBytes", "recipientUnreadMaxBytes", "childExtensions", "childSkills", "joinMode", "debug", "retentionDays", "maxTerminalRuns", "debugMaxBytes"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Invalid mesh settings ${file}: unknown key ${key}`);
  const integer = (key: keyof MeshSettings, min: number, max: number) => {
    const item = record[key];
    if (item === undefined) return;
    if (!Number.isInteger(item) || (item as number) < min || (item as number) > max) throw new Error(`Invalid mesh settings ${file}: ${key} must be ${min}-${max}`);
  };
  integer("maxAgentDepth", 1, 32);
  integer("maxConcurrentAgents", 1, 32);
  integer("maxNodes", 1, 128);
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
  if (record.debug !== undefined && typeof record.debug !== "boolean") throw new Error(`Invalid mesh settings ${file}: debug must be boolean`);
  return record as Partial<MeshSettings>;
}

export function loadMeshSettings(cwd: string, env: NodeJS.ProcessEnv = process.env, includeProject = true): MeshSettings {
  return meshSettingsFiles(cwd, env, includeProject).reduce((settings, file) => ({ ...settings, ...readSettings(file) }), { ...defaultMeshSettings });
}
