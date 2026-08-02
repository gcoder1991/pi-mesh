import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionHarness, context } from "../support/extension-harness.ts";

function ui(choices: Array<string | undefined>, inputs: Array<string | undefined> = [], editors: Array<string | undefined> = []) {
  const notifications: string[] = [];
  return {
    notifications,
    api: {
      notify(message: string) { notifications.push(message); },
      select: async () => choices.shift(), input: async () => inputs.shift(), editor: async () => editors.shift(), setWidget() {},
    },
  };
}

test("/agents creates, edits, disables, deletes, ejects, and updates settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-management-"));
  try {
    const harness = extensionHarness(); const command = harness.commands.get("agents");
    let surface = ui(["Create project agent"], ["custom", "Custom routing"], ["Custom prompt"]);
    await command.handler("", context(root, { ui: surface.api }));
    const custom = path.join(root, ".pi", "agents", "custom.md"); assert.equal(fs.existsSync(custom), true);

    surface = ui(["Agent types", "custom · project · Custom routing", "Disable"]);
    await command.handler("", context(root, { ui: surface.api })); assert.match(fs.readFileSync(custom, "utf8"), /enabled: false/);

    surface = ui(["Agent types", "worker · bundled · Implementation agent for focused code changes that require editing and verification", "Eject to project"]);
    await command.handler("", context(root, { ui: surface.api })); assert.equal(fs.existsSync(path.join(root, ".pi", "agents", "worker.md")), true);

    surface = ui(["Settings", "Max concurrency"], ["7"]);
    await command.handler("", context(root, { ui: surface.api })); assert.match(fs.readFileSync(path.join(root, ".pi", "mesh", "settings.yaml"), "utf8"), /maxConcurrentAgents: 7/);
    await harness.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("/agents is a no-op without dialog UI", async () => {
  const harness = extensionHarness();
  await assert.doesNotReject(() => harness.commands.get("agents").handler("", { ...context(process.cwd()), ui: undefined }));
  await harness.shutdown();
});

test("/mesh forces the task through mesh orchestration", async () => {
  const harness = extensionHarness();
  const command = harness.commands.get("mesh");
  await command.handler("review the release", { ...context(process.cwd()), isIdle: () => true });
  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0].userMessage, /must execute this request through the mesh tool/);
  assert.match(harness.messages[0].userMessage, /action \"list_agents\"/);
  assert.match(harness.messages[0].userMessage, /in the foreground/);
  assert.match(harness.messages[0].userMessage, /do not poll with mesh status\/list/);
  assert.match(harness.messages[0].userMessage, /review the release/);
  await harness.shutdown();
});
