import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./process-runner.mjs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("command completion waits for asynchronous resource registration", async (t) => {
  let release,
    settled = false;
  const child = new EventEmitter();
  child.pid = 12345;
  const stub = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
    release();
  });
  const registration = new Promise((resolve) => {
    release = resolve;
  });
  const pending = runCommand("fixture-command", [], {
    capture: true,
    onSpawn: () => registration,
  }).then((result) => {
    settled = true;
    return result;
  });
  child.emit("spawn");
  child.emit("close", 0);
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.equal((await pending).code, 0);
});

test("a failed registration reaps the child before rejecting", async () => {
  let childPid;
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      capture: true,
      onSpawn: async (pid) => {
        childPid = pid;
        throw new Error("registration failed");
      },
    }),
    /registration failed/,
  );
  assert.equal(alive(childPid), false);
});

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
