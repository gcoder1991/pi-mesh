import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { parse } from "yaml";
import type { MeshOperator, MeshTask } from "./manager.ts";
import { MeshTaskSchema } from "./schemas.ts";

const operators = new Set<MeshOperator>(["graph", "sequence", "parallel", "race", "supervisor", "mixture", "reflection", "debate"]);
const commandName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const placeholder = /\{\{([A-Za-z_][A-Za-z0-9_-]*)\}\}/g;
const reservedCommands = new Set(["agents", "changelog", "clone", "compact", "consensus", "copy", "export", "fork", "hotkeys", "import", "login", "logout", "mesh", "mesh-tree", "model", "name", "new", "quit", "reload", "resume", "scoped-models", "session", "settings", "share", "tree", "trust"]);

export interface MeshWorkflow {
  name: string;
  description?: string;
  source: "global" | "project";
  filePath: string;
  operator?: MeshOperator;
  worktree?: boolean;
  worktreeSetupHook?: string;
  maxConcurrency?: number;
  maxNodes?: number;
  failFast?: boolean;
  async?: boolean;
  promptInput?: string;
  inputs: Record<string, string>;
  tasks: MeshTask[];
}

interface WorkflowStage {
  id: string;
  operator: MeshOperator;
  dependsOn: string[];
  tasks: MeshTask[];
}

function workflowFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch { return []; }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a string map`);
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || typeof item !== "string") throw new Error(`${label} must be a string map`);
    result[key] = item;
  }
  return result;
}

function validateTasks(value: unknown, label: string): MeshTask[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error(`${label} must contain 1-32 tasks`);
  for (const [index, task] of value.entries()) {
    if (!Value.Check(MeshTaskSchema, task)) {
      const issue = Value.Errors(MeshTaskSchema, task)[0];
      throw new Error(`${label}[${index}] is invalid: ${issue?.message ?? "schema mismatch"}`);
    }
  }
  return value as MeshTask[];
}

function positiveInteger(value: unknown, label: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${label} must be 1-${max}`);
  return value as number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !commandName.test(item))) throw new Error(`${label} must be a list of IDs`);
  return value;
}

function compileStages(value: unknown, filePath: string): MeshTask[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`stages must contain at least one stage: ${filePath}`);
  const stages: WorkflowStage[] = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`stages[${index}] must be an object: ${filePath}`);
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!["id", "operator", "dependsOn", "tasks"].includes(key)) throw new Error(`Unknown stage key ${key}: ${filePath}`);
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!commandName.test(id)) throw new Error(`Invalid stage id at stages[${index}]: ${filePath}`);
    if (typeof record.operator !== "string" || !operators.has(record.operator as MeshOperator) || record.operator === "race") throw new Error(`Invalid or unsupported stage operator for ${id}: ${filePath}`);
    const tasks = validateTasks(record.tasks, `Stage ${id} tasks`);
    return { id, operator: record.operator as MeshOperator, dependsOn: stringList(record.dependsOn, `Stage ${id} dependsOn`), tasks };
  });
  const stageIds = new Set(stages.map((stage) => stage.id));
  if (stageIds.size !== stages.length) throw new Error(`Duplicate stage id: ${filePath}`);
  const outputs = new Map<string, string[]>();
  const tasks: MeshTask[] = [];
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) if (!outputs.has(dependency)) throw new Error(`Stage ${stage.id} depends on unknown or later stage ${dependency}: ${filePath}`);
    const prefix = `${stage.id}.`;
    const local = stage.tasks.map((task, index): MeshTask => {
      const id = `${prefix}${task.id?.trim() || `task-${index + 1}`}`;
      if (!commandName.test(id)) throw new Error(`Compiled task id is too long or invalid: ${id}`);
      return { ...task, id };
    });
    const localIds = new Set(local.map((task) => task.id!));
    if (localIds.size !== local.length) throw new Error(`Duplicate task id in stage ${stage.id}: ${filePath}`);
    for (const task of local) task.dependsOn = (task.dependsOn ?? []).map((id) => localIds.has(`${prefix}${id}`) ? `${prefix}${id}` : id);
    if (["sequence", "reflection", "debate"].includes(stage.operator)) {
      local.forEach((task, index) => { if (index) task.dependsOn = [...new Set([...(task.dependsOn ?? []), local[index - 1]!.id!])]; });
    } else if (["supervisor", "mixture"].includes(stage.operator)) {
      if (local.length < 2) throw new Error(`${stage.operator} stage ${stage.id} requires workers plus a final synthesizer`);
      local.at(-1)!.dependsOn = [...new Set([...(local.at(-1)!.dependsOn ?? []), ...local.slice(0, -1).map((task) => task.id!)])];
    }
    const internalDependencies = new Set(local.flatMap((task) => task.dependsOn ?? []).filter((id) => localIds.has(id)));
    const entries = local.filter((task) => !(task.dependsOn ?? []).some((id) => localIds.has(id)));
    const exits = local.filter((task) => !internalDependencies.has(task.id!)).map((task) => task.id!);
    const upstream = stage.dependsOn.flatMap((id) => outputs.get(id)!);
    for (const task of entries) task.dependsOn = [...new Set([...(task.dependsOn ?? []), ...upstream])];
    outputs.set(stage.id, exits);
    tasks.push(...local);
  }
  if (tasks.length > 32) throw new Error(`Compiled workflow exceeds 32 tasks: ${filePath}`);
  return tasks;
}
function loadWorkflow(filePath: string, source: MeshWorkflow["source"]): MeshWorkflow {
  const raw = fs.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error(`Workflow exceeds 1048576 bytes: ${filePath}`);
  const value = parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Workflow must be an object: ${filePath}`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(["name", "description", "operator", "worktree", "worktreeSetupHook", "maxConcurrency", "maxNodes", "failFast", "async", "promptInput", "inputs", "tasks", "stages"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unknown workflow key ${key}: ${filePath}`);
  const name = typeof record.name === "string" ? record.name.trim() : path.basename(filePath).replace(/\.ya?ml$/i, "");
  if (!commandName.test(name)) throw new Error(`Invalid workflow command name ${name}: ${filePath}`);
  if (reservedCommands.has(name)) throw new Error(`Workflow command name is reserved: ${name}`);
  if (record.description !== undefined && typeof record.description !== "string") throw new Error(`description must be a string: ${filePath}`);
  if (record.operator !== undefined && (typeof record.operator !== "string" || !operators.has(record.operator as MeshOperator))) throw new Error(`Invalid workflow operator: ${filePath}`);
  if (record.stages !== undefined && record.operator !== undefined) throw new Error(`Workflow stages compile to graph and cannot set a top-level operator: ${filePath}`);
  if (record.tasks !== undefined && record.stages !== undefined) throw new Error(`Workflow must use either tasks or stages, not both: ${filePath}`);
  const tasks = record.stages === undefined ? validateTasks(record.tasks, "tasks") : compileStages(record.stages, filePath);
  return {
    name,
    description: record.description?.toString().trim() || undefined,
    source,
    filePath,
    operator: record.stages === undefined ? record.operator as MeshOperator | undefined : "graph",
    worktree: optionalBoolean(record.worktree, "worktree"),
    worktreeSetupHook: typeof record.worktreeSetupHook === "string" ? record.worktreeSetupHook : undefined,
    maxConcurrency: positiveInteger(record.maxConcurrency, "maxConcurrency", 32),
    maxNodes: positiveInteger(record.maxNodes, "maxNodes", 128),
    failFast: optionalBoolean(record.failFast, "failFast"),
    async: optionalBoolean(record.async, "async"),
    promptInput: record.promptInput === undefined ? undefined : typeof record.promptInput === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(record.promptInput) ? record.promptInput : (() => { throw new Error(`promptInput must be an input name: ${filePath}`); })(),
    inputs: stringRecord(record.inputs, "inputs"),
    tasks: tasks as MeshTask[],
  };
}

export interface WorkflowDiscovery { workflows: MeshWorkflow[]; errors: string[]; }

export function discoverWorkflows(cwd: string, agentDir: string, includeProject: boolean): MeshWorkflow[] {
  return discoverWorkflowFiles(cwd, agentDir, includeProject).workflows;
}

export function discoverWorkflowFiles(cwd: string, agentDir: string, includeProject: boolean): WorkflowDiscovery {
  const workflows = new Map<string, MeshWorkflow>(), errors: string[] = [];
  const load = (files: string[], source: MeshWorkflow["source"]) => {
    for (const file of files) {
      try { const workflow = loadWorkflow(file, source); workflows.set(workflow.name, workflow); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
  };
  load(workflowFiles(path.join(agentDir, "mesh", "workflows")), "global");
  if (includeProject) load(workflowFiles(path.join(cwd, CONFIG_DIR_NAME, "mesh", "workflows")), "project");
  return { workflows: [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function parseWorkflowInputs(args: string, promptInput?: string): Record<string, string> {
  if (promptInput) {
    const prompt = args.trim();
    if (!prompt) throw new Error(`Usage: provide ${promptInput} after the command`);
    return { [promptInput]: prompt };
  }
  const result: Record<string, string> = Object.create(null);
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    const index = token.indexOf("=");
    if (index < 1) throw new Error(`Expected key=value, got ${token}`);
    const key = token.slice(0, index), value = token.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new Error(`Invalid input name: ${key}`);
    result[key] = value;
  }
  return result;
}

function renderText(text: string, inputs: Record<string, string>): string {
  return text.replace(placeholder, (_match, key: string) => {
    if (!Object.hasOwn(inputs, key)) throw new Error(`Missing workflow input: ${key}`);
    return inputs[key]!;
  });
}

export function instantiateWorkflow(workflow: MeshWorkflow, provided: Record<string, string>): MeshWorkflow {
  const inputs = Object.assign(Object.create(null), workflow.inputs, provided) as Record<string, string>;
  const render = (value: unknown): unknown => {
    if (typeof value === "string") return renderText(value, inputs);
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
    return value;
  };
  return { ...workflow, worktreeSetupHook: workflow.worktreeSetupHook ? renderText(workflow.worktreeSetupHook, inputs) : undefined, inputs, tasks: render(workflow.tasks) as MeshTask[] };
}
