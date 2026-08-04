import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

export const mockPi = path.resolve("test/support/mock-pi.mjs");

export interface E2EFixture {
  root: string;
  queue: string;
  cleanup(): void;
}

export function fixture(git = false): E2EFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-e2e-"));
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-e2e-queue-"));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  for (const name of ["worker", "reviewer", "scout"]) fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\ntools: read,bash\n---\nDo the task.\n`);
  if (git) {
    gitRun(root, "init");
    fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(root, "base.txt"), "base\n");
    gitRun(root, "add", ".");
    gitRun(root, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-m", "base");
  }
  return { root, queue, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(queue, { recursive: true, force: true }); } };
}

export function gitRun(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

export function response(queue: string, index: number, value: object): void {
  fs.writeFileSync(path.join(queue, `pending-${String(index).padStart(3, "0")}.json`), JSON.stringify(value));
}

export async function loadMeshTool(root: string, extension = path.resolve("index.ts")): Promise<any> {
  const loaded = await discoverAndLoadExtensions([extension], root);
  if (loaded.errors.length) throw new Error(loaded.errors.map((error) => error.error).join("\n"));
  const tool = loaded.extensions.flatMap((item) => [...item.tools.values()]).find((item) => item.definition.name === "mesh")?.definition;
  if (!tool) throw new Error("mesh tool was not registered");
  return tool;
}

export async function execute(tool: any, root: string, params: object, signal = new AbortController().signal, projectTrusted = true, modelRegistry: any = { getAvailable: () => [] }): Promise<any> {
  return tool.execute("e2e", params, signal, undefined, { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => projectTrusted, sessionManager: { getSessionId: () => "e2e-session" }, modelRegistry });
}

export function env(queue: string): NodeJS.ProcessEnv {
  return { ...process.env, PI_MESH_PI_BINARY: mockPi, PI_MESH_TEST_QUEUE: queue };
}

export function runNode(script: string, args: string[], environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
