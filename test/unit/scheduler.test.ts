import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentScheduler } from "../../src/scheduler.ts";

test("scheduler supports one-shot, interval, cron, persistence, list, and cancel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-schedule-")); const fired: string[] = [];
  try {
    const scheduler = new AgentScheduler(root, "session", (job) => { fired.push(job.id); });
    const once = scheduler.add({ name: "once", schedule: "+1s", prompt: "x", agent: "worker" });
    const interval = scheduler.add({ name: "interval", schedule: "1s", prompt: "x", agent: "worker" });
    const cron = scheduler.add({ name: "cron", schedule: "0 */5 * * * *", prompt: "x", agent: "worker" });
    assert.equal(scheduler.list().length, 3); assert.equal(scheduler.cancel(cron.id), true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.ok(fired.includes(once.id)); assert.ok(fired.includes(interval.id)); assert.equal(scheduler.list().some((job) => job.id === once.id), false);
    scheduler.dispose();
    const restored = new AgentScheduler(root, "session", () => {}); assert.equal(restored.list().some((job) => job.id === interval.id), true); restored.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scheduler restores absolute one-shot time and persisted launch options", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-schedule-restore-"));
  const file = path.join(root, ".pi", "mesh", "schedules", "session.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const nextRun = Date.now() + 5000;
    fs.writeFileSync(file, JSON.stringify([{ id: "once", name: "once", schedule: "+1h", prompt: "x", agent: "worker", createdAt: Date.now(), nextRun, type: "once", model: "provider/model", thinking: "high", maxTurns: 7, persistent: true, transcript: false, sessionDir: "/sessions" }]));
    const scheduler = new AgentScheduler(root, "session", () => {});
    const [job] = scheduler.list();
    assert.ok(Math.abs(job.nextRun! - nextRun) < 100);
    assert.equal(job.model, "provider/model"); assert.equal(job.thinking, "high"); assert.equal(job.maxTurns, 7); assert.equal(job.persistent, true); assert.equal(job.transcript, false); assert.equal(job.sessionDir, "/sessions");
    scheduler.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scheduler contains async fire failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-schedule-error-"));
  try {
    const scheduler = new AgentScheduler(root, "session", async () => { throw new Error("boom"); });
    scheduler.add({ name: "once", schedule: "+1s", prompt: "x", agent: "worker" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(scheduler.list().length, 0);
    scheduler.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scheduler rejects malformed or oversized registries and jobs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-schedule-invalid-"));
  const file = path.join(root, ".pi", "mesh", "schedules", "session.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, "nope"); assert.throws(() => new AgentScheduler(root, "session", () => {}), /Invalid JSON state/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x" }])); assert.throws(() => new AgentScheduler(root, "session", () => {}), /malformed job/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", name: "x", schedule: "broken", prompt: "x", agent: "worker", createdAt: Date.now(), type: "interval" }])); assert.throws(() => new AgentScheduler(root, "session", () => {}), /Invalid schedule registry.*schedule must/);
    fs.writeFileSync(file, JSON.stringify([{ id: "x", name: "x", schedule: "+1h", prompt: "x", agent: "worker", createdAt: Date.now(), type: "interval" }])); assert.throws(() => new AgentScheduler(root, "session", () => {}), /schedule type does not match/);
    fs.writeFileSync(file, "[]"); const scheduler = new AgentScheduler(root, "session", () => {});
    assert.throws(() => scheduler.add({ name: "x", schedule: "+1s", prompt: "", agent: "worker" }), /Invalid scheduled agent job/); scheduler.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
