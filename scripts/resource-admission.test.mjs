import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireResources } from "./resource-admission.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "test admission "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, pollMs: 5, freeMemory: () => 16 * 1024 ** 3 };
}
const small = { workers: 1, memoryGiB: 1, browsers: 0 };

test("four independent callers respect capacity and progress in FIFO order", async (t) => {
  const options = await fixture(t);
  const events = [];
  let active = 0,
    peak = 0;
  let filled;
  const firstPair = new Promise((resolve) => {
    filled = resolve;
  });
  await Promise.all(
    [0, 1, 2, 3].map(async (id) => {
      const lease = await acquireResources(small, options);
      events.push(id);
      peak = Math.max(peak, ++active);
      if (active === 2) filled();
      await firstPair;
      active--;
      await lease.release();
    }),
  );
  assert.equal(peak, 2);
  assert.deepEqual([...events].sort(), [0, 1, 2, 3]);
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("a queued browser cannot exceed the browser cap and cancellation releases its ticket", async (t) => {
  const options = await fixture(t);
  const browser = { ...small, browsers: 1 };
  const first = await acquireResources(browser, options);
  const abort = new AbortController();
  const queued = acquireResources(browser, {
    ...options,
    signal: abort.signal,
  });
  const rejection = assert.rejects(queued, /cancel/i);
  await delay(20);
  abort.abort();
  await rejection;
  await first.release();
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("memory pressure queues work until capacity returns", async (t) => {
  const options = await fixture(t);
  let free = 3 * 1024 ** 3;
  let admitted = false;
  const pending = acquireResources(small, {
    ...options,
    freeMemory: () => free,
  }).then((lease) => {
    admitted = true;
    return lease;
  });
  await delay(30);
  assert.equal(admitted, false);
  free = 12 * 1024 ** 3;
  await (await pending).release();
});

test("abandoned tickets do not block work; an impossible request fails immediately", async (t) => {
  const options = await fixture(t);
  const first = await acquireResources(small, options);
  await first.release();
  await writeFile(
    join(options.directory, "queue", "000-dead.json"),
    JSON.stringify({ pid: 2147483647, request: small, active: true }),
  );
  const lease = await acquireResources(small, options);
  await lease.release();
  await assert.rejects(
    acquireResources({ ...small, workers: 3 }, options),
    /capacity/,
  );
});
