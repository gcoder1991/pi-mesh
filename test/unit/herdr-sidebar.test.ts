import assert from "node:assert/strict";
import test from "node:test";
import { registerHerdrSidebar, type HerdrSidebarAgent } from "../../src/herdr-sidebar.ts";

test("Herdr sidebar reports active mesh agents and clears the left-sidebar label", async () => {
  let agents: HerdrSidebarAgent[] = [];
  const commands: string[][] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const sidebar = registerHerdrSidebar({
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "workspace:pane" },
    events: { emit: (event, data) => events.push({ event, data }) },
    getAgents: () => agents,
    runHerdr: (args) => { commands.push([...args]); },
    pollMs: 0,
  });

  sidebar.sessionStarted(true);
  agents = [
    { id: "run/a", agent: "planner", status: "running" },
    { id: "run/b", agent: "worker", status: "queued" },
    { id: "run/c", agent: "reviewer", status: "succeeded" },
  ];
  sidebar.refresh();
  await sidebar.flush();

  assert.equal(commands.length, 1);
  assert.ok(commands[0]?.includes("pi-mesh:herdr"));
  assert.ok(commands[0]?.includes("summary=● 2 agents active · planner, worker"));
  assert.deepEqual(events.at(-1), { event: "herdr:busy", data: { active: true, label: "● 2 agents active · planner, worker" } });

  agents = [];
  sidebar.refresh();
  await sidebar.flush();
  assert.ok(commands.at(-1)?.includes("--clear-state-labels"));
  assert.deepEqual(events.at(-1), { event: "herdr:busy", data: { active: false } });
  sidebar.dispose();
});

test("Herdr sidebar stays inert outside Herdr", async () => {
  const commands: string[][] = [];
  const sidebar = registerHerdrSidebar({
    env: {},
    events: { emit() {} },
    getAgents: () => [{ id: "run/a", agent: "worker", status: "running" }],
    runHerdr: (args) => { commands.push([...args]); },
    pollMs: 0,
  });
  sidebar.sessionStarted(true);
  sidebar.refresh();
  await sidebar.flush();
  assert.deepEqual(commands, []);
});
