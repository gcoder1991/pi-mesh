#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";

const pidFile = process.env.PI_MESH_TREE_PID_FILE;
if (!pidFile) process.exit(2);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(pidFile, String(grandchild.pid));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!buffer.includes("\n")) return;
  process.stdout.write(`${JSON.stringify({ type: "response", command: "prompt", success: true })}\n`);
  setTimeout(() => process.stdout.write(`${JSON.stringify({ type: "response", command: "abort", success: true })}\n`), 5000).unref?.();
});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
