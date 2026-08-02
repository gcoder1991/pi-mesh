#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const queue = process.env.PI_MESH_TEST_QUEUE;
if (!queue) process.exit(2);
fs.mkdirSync(queue, { recursive: true });
const rpc = process.argv.includes("rpc");
let response;

function claimResponse(task = "") {
  const names = fs.readdirSync(queue).filter((item) => item.startsWith("pending-")).sort();
  const normalizedTask = task.match(/Task:\s*([^\n]+)/)?.[1]?.trim().toLowerCase() ?? "";
  const ranked = names.map((name) => {
    let value = {};
    try { value = JSON.parse(fs.readFileSync(path.join(queue, name), "utf8")); } catch {}
    const output = String(value.output ?? "").trim().toLowerCase();
    const file = path.basename(String(value.writeFile ?? ""), path.extname(String(value.writeFile ?? ""))).toLowerCase();
    return { name, value, match: normalizedTask && (output === normalizedTask || file === normalizedTask) };
  }).sort((a, b) => Number(b.match) - Number(a.match) || a.name.localeCompare(b.name));
  for (const item of ranked) {
    const claimed = item.name.replace("pending-", `claimed-${process.pid}-`);
    try {
      fs.renameSync(path.join(queue, item.name), path.join(queue, claimed));
      response = item.value;
      return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  response = { output: "ok", exitCode: 0 };
}

if (!rpc) claimResponse();
const callFile = path.join(queue, `call-${Date.now()}-${process.pid}.json`);
fs.writeFileSync(callFile, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));

const emitStderr = () => {
  const stderr = response?.stderr ?? (response?.stderrBytes ? "e".repeat(response.stderrBytes) : "");
  if (stderr) process.stderr.write(stderr);
};
const message = (includeError = false) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: response?.output ?? "ok" }],
    model: "mock/model",
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    ...(includeError && response?.exitCode && response.exitCode !== 0 ? { errorMessage: response.stderr || `Pi exited with code ${response.exitCode}` } : {}),
  },
});

if (rpc) {
  let buffer = "";
  const finishPrompt = () => setTimeout(() => {
    if (response.writeFile) fs.writeFileSync(path.resolve(response.writeFile), response.writeContent ?? process.cwd());
    const emit = () => process.stdout.write(`${JSON.stringify(message(true))}\n${JSON.stringify({ type: "agent_settled" })}\n`);
    const stderr = response?.stderr ?? (response?.stderrBytes ? "e".repeat(response.stderrBytes) : "");
    if (stderr) process.stderr.write(stderr, emit); else emit();
  }, response.delay ?? 0);
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let command;
      try { command = JSON.parse(line); } catch { continue; }
      if (command.type === "prompt") {
        claimResponse(command.message);
        fs.writeFileSync(callFile, JSON.stringify({ args: [...process.argv.slice(2), command.message], cwd: process.cwd() }));
        process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true })}\n`);
        finishPrompt();
      } else if (command.type === "steer") {
        process.stdout.write(`${JSON.stringify({ type: "response", command: "steer", success: true })}\n`);
      } else if (command.type === "abort") {
        process.stdout.write(`${JSON.stringify({ type: "response", command: "abort", success: true })}\n`);
        setTimeout(() => process.exit(143), 5);
      }
    }
  });
  process.on("SIGTERM", () => process.exit(143));
} else {
  if (response.writeFile) fs.writeFileSync(path.resolve(response.writeFile), response.writeContent ?? process.cwd());
  const finish = () => {
    if (response.rawStdoutBytes) { process.stdout.write("x".repeat(response.rawStdoutBytes), () => process.exit(response.exitCode ?? 0)); return; }
    const stderr = response?.stderr ?? (response?.stderrBytes ? "e".repeat(response.stderrBytes) : "");
    const emit = () => process.stdout.write(`${JSON.stringify(message())}\n`, () => process.exit(response.exitCode ?? 0));
    if (stderr) process.stderr.write(stderr, emit); else emit();
  };
  process.on("SIGTERM", () => process.exit(143));
  setTimeout(finish, response.delay ?? 0);
}
