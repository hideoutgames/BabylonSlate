import { test } from "node:test";
import assert from "node:assert/strict";
import { runStage, unitProfile } from "./test-runner.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireResources } from "./resource-admission.mjs";

test("explicit Node and docs tests use the lighter unit workload", () => {
  assert.equal(unitProfile(["--project", "node", "packages/core"]), "unit");
  assert.equal(unitProfile(["--project=node", "packages/core"]), "unit");
  assert.equal(unitProfile(["apps/docs/src/sidebar.test.ts"]), "unit");
  assert.equal(unitProfile(["playwright.config.test.ts"]), "unit");
  assert.equal(unitProfile(["apps/editor/src/panel.test.tsx"]), "focused");
  assert.equal(unitProfile([]), "dom");
});

test("the fast profile reaches the actual child worker settings; CI keeps its fixed limits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "runner lease "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lease = await acquireResources(
    { workers: 2, browsers: 1, memoryGiB: 6 },
    {
      directory,
      freeMemory: () => 16 * 1024 ** 3,
    },
  );
  t.after(() => lease.release());
  for (const [env, expected] of [
    [{ BL_TEST_PROFILE: "fast", CI: "" }, ["2", "2"]],
    [{ BL_TEST_PROFILE: "fast", CI: "true" }, ["2", "1"]],
  ]) {
    const result = await runStage(
      "unit",
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify([process.env.VITEST_MAX_WORKERS,process.env.BL_TEST_BROWSER_WORKERS]))",
      ],
      {
        env: {
          ...env,
          BL_TEST_LEASE: JSON.stringify({
            ticket: lease.ticket,
            token: lease.token,
          }),
        },
        capture: true,
      },
    );
    assert.deepEqual(JSON.parse(result.output), expected);
  }
});
