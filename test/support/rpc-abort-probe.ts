import fs from "node:fs";
import type { AgentDefinition } from "../../src/agents.ts";
import { createRpcChild } from "../../src/rpc-child.ts";

const [cwd, resultFile] = process.argv.slice(2);
if (!cwd || !resultFile) process.exit(2);
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };
const session = createRpcChild(agent, cwd, { args: [] });
const started = Date.now();
const resultPromise = session.prompt("slow");
setTimeout(() => session.abort(), 25).unref?.();
const result = await resultPromise;
fs.writeFileSync(resultFile, JSON.stringify({ elapsed: Date.now() - started, result }));
