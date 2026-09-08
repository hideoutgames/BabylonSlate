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
    { pid: 4, parent: 3, started: 4 },
    { pid: 2, parent: 1, started: 2 },
    { pid: 3, parent: 2, started: 3 },
    { pid: 7, parent: 1, started: 7 },
    { pid: 8, parent: 7, started: 8 },
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
    [2, 2],
    [3, 3],
  ]);
  const rows = [
    { pid: 2, parent: 1, started: 5 },
    { pid: 3, parent: 1, started: 3 },
    { pid: 4, parent: 2, started: 6 },
  ];
  assert.deepEqual(
    ownedProcesses(rows, new Set([2]), observed).map((row) => row.pid),
    [3],
  );
});

test("a reused parent PID cannot adopt an older unrelated process tree", () => {
  const rows = [
    { pid: 2, parent: 1, started: 200 },
    { pid: 3, parent: 2, started: 100 },
    { pid: 4, parent: 2, started: 201 },
    { pid: 5, parent: 3, started: 202 },
  ];
  assert.deepEqual(
    ownedProcesses(rows, [2]).map((row) => row.pid),
    [2, 4],
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
