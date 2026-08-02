import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.ts";

const MAX_MEMORY_BYTES = 256 * 1024;
function memoryDir(agent: AgentDefinition, cwd: string): string | undefined {
  if (agent.memory === "project") return path.join(cwd, CONFIG_DIR_NAME, "agent-memory", agent.name);
  if (agent.memory === "local") return path.join(cwd, CONFIG_DIR_NAME, "agent-memory-local", agent.name);
  if (agent.memory === "user") return path.join(getAgentDir(), "agent-memory", agent.name);
  return undefined;
}
export function memoryPrompt(agent: AgentDefinition, cwd: string): string {
  const dir = memoryDir(agent, cwd); if (!dir) return "";
  const index = path.join(dir, "MEMORY.md");
  let content = "";
  try { content = fs.readFileSync(index, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) content = Buffer.from(content).subarray(0, MAX_MEMORY_BYTES).toString("utf8");
  const writable = agent.tools?.some((tool) => tool === "write" || tool === "edit") && !agent.disallowedTools?.some((tool) => tool === "write" || tool === "edit");
  return `\n\n## Agent memory\nMemory directory: ${dir}\n${writable ? "You may update MEMORY.md and supporting files when durable knowledge is genuinely useful." : "Memory is read-only for this agent."}\n\n${content}`;
}
