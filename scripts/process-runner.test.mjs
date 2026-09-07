import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./process-runner.mjs";

test("commands preserve arguments without a shell and propagate failure", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)));process.exitCode=7",
      "literal $(value)",
      "space and ü",
    ],
    { capture: true },
  );
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(result.output), [
    "literal $(value)",
    "space and ü",
  ]);
});

test("cancellation stops the owned process tree", async () => {
  const abort = new AbortController();
  const result = await runCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {
      signal: abort.signal,
      capture: true,
      onSpawn: () => abort.abort(),
    },
  );
  assert.notEqual(result.code, 0);
});
