import { test } from "node:test";
import assert from "node:assert/strict";
import { ownedProcesses, startSampling } from "./benchmark-tests.mjs";

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
