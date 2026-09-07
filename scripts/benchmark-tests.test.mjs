import { test } from "node:test";
import assert from "node:assert/strict";
import { ownedProcesses } from "./benchmark-tests.mjs";

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
