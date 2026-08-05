import assert from "node:assert/strict";
import test from "node:test";
import { clearSessionFleetLimiters, FleetLimiter, sessionFleetLimiter } from "../../src/fleet-limiter.ts";

test("fleet limiter shares a bounded session slot pool", async () => {
  const limiter = new FleetLimiter(1);
  const releaseFirst = await limiter.acquire();
  let entered = false;
  const second = limiter.acquire().then((release) => { entered = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(entered, false);
  assert.equal(limiter.active, 1);
  assert.equal(limiter.queued, 1);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(entered, true);
  assert.equal(limiter.active, 1);
  releaseSecond();
  assert.equal(limiter.active, 0);
});

test("fleet limiter removes aborted waiters", async () => {
  const limiter = new FleetLimiter(1);
  const release = await limiter.acquire();
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(limiter.queued, 0);
  release();
  assert.equal(limiter.active, 0);
});

test("session fleet limiter cache can be cleared on shutdown", () => {
  const first = sessionFleetLimiter("clear-test", 1);
  assert.equal(sessionFleetLimiter("clear-test", 1), first);
  clearSessionFleetLimiters();
  assert.notEqual(sessionFleetLimiter("clear-test", 1), first);
  clearSessionFleetLimiters();
});
