import { test } from "node:test";
import assert from "node:assert/strict";
import { runSelectedUnitTests } from "./verify-local.mjs";

test("targeted consumer checks keep editor tests in the bounded editor runner", async () => {
  const commands = [],
    calls = [];
  await runSelectedUnitTests(
    [{ path: "packages/source-control" }, { path: "apps/editor" }],
    commands,
    {},
    async (mode, args) => {
      calls.push([mode, args]);
    },
  );
  assert.deepEqual(calls, [
    ["unit", ["packages/source-control", "--passWithNoTests"]],
    ["editor", []],
  ]);
  assert.deepEqual(commands, [
    ["test", "packages/source-control"],
    ["test:editor-unit"],
  ]);
});

test("a package-only selection does not start the editor runner", async () => {
  const calls = [];
  await runSelectedUnitTests(
    [{ path: "packages/core" }],
    [],
    {},
    async (mode, args) => {
      calls.push([mode, args]);
    },
  );
  assert.deepEqual(calls, [["unit", ["packages/core", "--passWithNoTests"]]]);
});
