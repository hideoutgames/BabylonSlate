import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { batches, chooseJobs, memoryBudgetGiB, PROGRAMS } from "../apps/editor/scripts/typecheck.mjs";

const GIB = 1024 ** 3;
const script = fileURLToPath(new URL("../apps/editor/scripts/typecheck.mjs", import.meta.url));
const names = (plan) => plan.map((batch) => batch.map((program) => program.name));

test("four jobs run every program together, two pair the largest apart, one runs them in order", () => {
  assert.deepEqual(names(batches(PROGRAMS, 4)), [["app", "test", "node", "e2e"]]);
  assert.deepEqual(names(batches(PROGRAMS, 2)), [["test", "node"], ["app", "e2e"]]);
  assert.deepEqual(names(batches(PROGRAMS, 3)), [["test", "node"], ["app", "e2e"]]);
  assert.deepEqual(names(batches(PROGRAMS, 1)), [["app"], ["test"], ["node"], ["e2e"]]);
  // The production build checks the app alone, whatever the machine.
  const app = PROGRAMS.filter((program) => program.name === "app");
  for (const jobs of [1, 2, 4]) assert.deepEqual(names(batches(app, jobs)), [["app"]]);
});

test("a machine runs as many programs at once as its spare memory and CPUs allow", () => {
  const jobs = (platform, totalGiB, availableGiB, cpus, constrainedGiB = 0) =>
    chooseJobs(PROGRAMS, memoryBudgetGiB({ platform, total: totalGiB * GIB, available: availableGiB * GIB, constrained: constrainedGiB * GIB }), cpus);
  // A standard GitHub-hosted Linux runner: 4 CPUs, 16 GB.
  assert.equal(jobs("linux", 15.6, 14.5, 4), 4);
  // The same runner with other work already holding memory, or a container capped at 8 GB.
  assert.equal(jobs("linux", 15.6, 7, 4), 2);
  assert.equal(jobs("linux", 15.6, 14.5, 4, 8), 2);
  // Too few CPUs for four, or too little memory for two.
  assert.equal(jobs("linux", 32, 30, 2), 2);
  assert.equal(jobs("linux", 32, 30, 1), 1);
  assert.equal(jobs("linux", 8, 5, 4), 1);
  // macOS and Windows report too little free memory to trust, so total memory less a reserve decides:
  // the 7 GB standard macOS runner runs them one by one.
  assert.equal(jobs("darwin", 7, 0.5, 3), 1);
  assert.equal(jobs("darwin", 16, 0.5, 4), 4);
  assert.equal(jobs("win32", 8, 0.5, 8), 1);
});

test("an unknown program or a malformed job count fails before any program runs", () => {
  for (const [args, env, message] of [
    [["lint"], {}, /Unknown typecheck program: lint/],
    [["--jobs", "0"], {}, /--jobs must be a whole number/],
    [["--jobs"], {}, /--jobs must be a whole number/],
    [[], { HAPTIC_TYPECHECK_JOBS: "two" }, /HAPTIC_TYPECHECK_JOBS must be a whole number/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /passed|failed in/);
  }
});
