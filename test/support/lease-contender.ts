import { spawn } from "node:child_process";

const [script, cwd, runId] = process.argv.slice(2);
const first = spawn(process.execPath, ["--experimental-strip-types", script, cwd, runId, "800"], { stdio: ["ignore", "pipe", "pipe"] });
let pending = "";
first.stdout.on("data", (chunk) => {
  pending += chunk;
  if (!pending.includes("acquired")) return;
  const second = spawn(process.execPath, ["--experimental-strip-types", script, cwd, runId, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  second.stderr.on("data", (chunk) => { stderr += chunk; });
  second.on("close", (code) => {
    process.stdout.write(JSON.stringify({ code, stderr }));
  });
});
first.on("close", (code) => { if (code !== 0) process.exit(code ?? 1); });
