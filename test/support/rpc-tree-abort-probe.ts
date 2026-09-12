import fs from "node:fs";
import type { AgentDefinition } from "../../src/agents.ts";
import { createRpcChild } from "../../src/rpc-child.ts";

const [cwd, pidFile, resultFile] = process.argv.slice(2);
if (!cwd || !pidFile || !resultFile) process.exit(2);
const agent: AgentDefinition = { name: "worker", description: "worker", tools: ["read"], systemPrompt: "work", source: "bundled", filePath: "worker.md" };
let ready!: () => void;
const accepted = new Promise<void>(resolve => { ready = resolve; });
const events: unknown[] = [];
const session = createRpcChild(agent, cwd, { args: [], env: { PI_MESH_TREE_PID_FILE: pidFile }, onEvent(event) { events.push(event); if (event.type === "prompt_accepted") ready(); } });
const resultPromise = session.prompt("slow");
let timer: NodeJS.Timeout | undefined;
try {
  await Promise.race([accepted, resultPromise.then(result => { throw new Error(`Child exited before readiness: ${JSON.stringify(result)}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Child prompt not accepted within 5s; pidFile=${fs.existsSync(pidFile)} events=${JSON.stringify(events)}`)), 5000); })]);
  clearTimeout(timer);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid grandchild PID: ${pid}`);
  process.kill(pid, 0); // the test must actually have a live grandchild to kill
  session.abort();
  const result = await resultPromise;
  fs.writeFileSync(resultFile, JSON.stringify(result));
} finally { clearTimeout(timer); await session.close(); }
