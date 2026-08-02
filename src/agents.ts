import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "bundled" | "user" | "project" | "all";
export type AgentSource = "bundled" | "user" | "project";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  thinking?: string;
  maxTurns?: number;
  promptMode?: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  isolation?: "worktree";
  extensions?: string[];
  skills?: string[];
  persistSession?: boolean;
  outputTranscript?: boolean;
  memory?: "project" | "local" | "user";
  allowedSubagents?: string[] | "all";
  enabled?: boolean;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export const BUNDLED_AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url));

function loadDirectory(dir: string, source: AgentSource): AgentDefinition[] {
  let entries: fs.Dirent[];
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const { frontmatter, body } = parseFrontmatter<Record<string, string>>(fs.readFileSync(filePath, "utf8"));
      const name = frontmatter.name || path.basename(entry.name, ".md");
      if (!frontmatter.description) continue;
      const csv = (value?: string) => value?.split(",").map((item) => item.trim()).filter(Boolean);
      const boolean = (value?: string) => value === undefined ? undefined : /^(true|yes|1)$/i.test(value);
      const maxTurns = frontmatter.max_turns ? Number(frontmatter.max_turns) : undefined;
      const enabled = boolean(frontmatter.enabled);
      if (enabled === false) continue;
      const extensions = csv(frontmatter.extensions)?.filter((item) => !["false", "none"].includes(item.toLowerCase()));
      const skills = csv(frontmatter.skills)?.filter((item) => !["false", "none"].includes(item.toLowerCase()));
      if (extensions?.some((item) => item === "*" || item.toLowerCase() === "true" || path.isAbsolute(item) || item.includes("/") || item.includes("\\"))) continue;
      if (skills?.some((item) => item === "*" || item.toLowerCase() === "true" || path.isAbsolute(item) || item.includes("/") || item.includes("\\"))) continue;
      const tools = csv(frontmatter.tools);
      agents.push({
        name,
        description: frontmatter.description,
        tools: tools?.length ? tools : undefined,
        disallowedTools: csv(frontmatter.disallowed_tools),
        model: frontmatter.model,
        thinking: frontmatter.thinking,
        maxTurns: Number.isInteger(maxTurns) && maxTurns! > 0 ? maxTurns : undefined,
        promptMode: frontmatter.prompt_mode === "append" ? "append" : "replace",
        inheritContext: boolean(frontmatter.inherit_context),
        runInBackground: boolean(frontmatter.run_in_background),
        isolated: boolean(frontmatter.isolated),
        isolation: frontmatter.isolation === "worktree" ? "worktree" : undefined,
        extensions,
        skills,
        persistSession: boolean(frontmatter.persist_session),
        outputTranscript: boolean(frontmatter.output_transcript),
        memory: ["project", "local", "user"].includes(frontmatter.memory ?? "") ? frontmatter.memory as "project" | "local" | "user" : undefined,
        allowedSubagents: ["all", "*", "true"].includes(frontmatter.allowed_subagents?.toLowerCase() ?? "") ? "all" : csv(frontmatter.allowed_subagents)?.filter((item) => !["false", "none"].includes(item.toLowerCase())),
        enabled,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch {
      // Ignore unreadable or malformed definitions; list() makes omissions visible.
    }
  }
  return agents;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    try {
      if (!fs.lstatSync(candidate).isSymbolicLink() && fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface DiscoverAgentOptions {
  scope?: AgentScope;
  includeProject?: boolean;
  projectRoot?: string;
}

export function bundledAgents(): AgentDefinition[] { return loadDirectory(BUNDLED_AGENTS_DIR, "bundled"); }

export function discoverAgents(cwd: string, options: AgentScope | DiscoverAgentOptions = "all"): AgentDefinition[] {
  const { scope = "all", includeProject = true, projectRoot } = typeof options === "string" ? { scope: options } : options;
  const sources: Array<[string, AgentSource]> = [];
  if (scope === "bundled" || scope === "all") sources.push([BUNDLED_AGENTS_DIR, "bundled"]);
  if (scope === "user" || scope === "all") sources.push([path.join(getAgentDir(), "agents"), "user"]);
  if (includeProject && (scope === "project" || scope === "all")) {
    const projectDir = projectRoot ? path.join(path.resolve(projectRoot), CONFIG_DIR_NAME, "agents") : nearestProjectAgentsDir(cwd);
    if (projectDir) sources.push([projectDir, "project"]);
  }

  const byName = new Map<string, AgentDefinition>();
  for (const [dir, source] of sources) {
    for (const agent of loadDirectory(dir, source)) byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
