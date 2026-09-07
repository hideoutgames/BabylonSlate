import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownedProcesses,
  startSampling,
  waitForExit,
} from "./benchmark-tests.mjs";

test("slow resource sampling never accumulates queued snapshots", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release;
  let samples = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const stop = startSampling(async () => {
    samples++;
    await pending;
  }, 10);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(samples, 1);
  release();
  await stop();
  assert.equal(samples, 1);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(samples, 1);
});

test("resource measurements include owned descendants and exclude another agent", () => {
  const rows = [
    { pid: 4, parent: 3 },
    { pid: 2, parent: 1 },
    { pid: 3, parent: 2 },
    { pid: 7, parent: 1 },
    { pid: 8, parent: 7 },
  ];
  assert.deepEqual(
    ownedProcesses(rows, [2])
      .map((row) => row.pid)
      .sort(),
    [2, 3, 4],
  );
});

test("PID reuse cannot attribute another process tree to a completed workload", () => {
  const observed = new Map([
    [2, "old-root"],
    [3, "owned-child"],
  ]);
  const rows = [
    { pid: 2, parent: 1, started: "new-root" },
    { pid: 3, parent: 1, started: "owned-child" },
    { pid: 4, parent: 2, started: "unrelated-child" },
  ];
  assert.deepEqual(
    ownedProcesses(rows, new Set([2]), observed).map((row) => row.pid),
    [3],
  );
});

test("the cleanup check allows normal shutdown but reports persistent descendants", async () => {
  const child = { pid: 3, parent: 2, started: "owned-child" };
  let running = true;
  assert.deepEqual(
    await waitForExit(
      async () => (running ? [child] : []),
      async () => {
        running = false;
      },
    ),
    [],
  );
  assert.deepEqual(
    await waitForExit(
      async () => [child],
      async () => {},
    ),
    [child],
  );
});
