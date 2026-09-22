import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutionPlan, workerArguments } from "./execution-plan.mjs";

test("low-memory policy clamps fast/CI requests without making builds impossible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "machine.json");
  for (const reserve of [1, 4.5]) {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "low-memory",
        reserveGiB: reserve,
        maxHeavy: 3,
        maxBypasses: 10,
      }),
    );
    for (const profile of ["build", "unit", "browser", "coverage", "tooling"]) {
      const plan = await resolveExecutionPlan(profile, {
        CI: "true",
        BL_TEST_PROFILE: "fast",
        BL_LOCAL_RESOURCE_CONFIG: path,
      });
      assert.equal(plan.hosted, false);
      assert.equal(plan.workers, 1);
      assert.equal(plan.browserWorkers, 1);
      assert.equal(plan.retries, 0);
      assert.equal(plan.config.capacity.reserveGiB, Math.max(3, reserve));
      assert.equal(plan.config.maxRoots, 1);
      assert.equal(plan.config.maxBypasses, 0);
      assert.ok(plan.request.workers <= plan.config.capacity.workers);
      assert.ok(Object.isFrozen(plan.request));
      assert.ok(
        workerArguments(["selected.test.ts"], plan, "vitest").includes(
          "--maxWorkers=1",
        ),
      );
      assert.ok(
        workerArguments(["selected.spec.ts"], plan, "browser").includes(
          "--workers=1",
        ),
      );
      for (const flag of [
        "--maxWorkers=8",
        "--max-workers=8",
        "--minWorkers",
        "--fileParallelism=true",
        "--retry=4",
      ])
        assert.throws(
          () => workerArguments([flag], plan, "vitest"),
          /overrides/,
        );
      for (const flag of ["--workers=7", "-j4", "--retries=2"])
        assert.throws(
          () => workerArguments([flag], plan, "browser"),
          /overrides/,
        );
    }
  }
  await assert.rejects(
    resolveExecutionPlan("unit", { BL_LOCAL_RESOURCE_CONFIG: "" }),
    /empty override/,
  );
});

test("partial/spurious CI context cannot select hosted execution", async () => {
  const hosted = {
    BL_EXECUTION_POLICY: "hosted-ci",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "123",
    GITHUB_REPOSITORY: "fixture/repo",
    RUNNER_OS: "Linux",
  };
  for (const key of [
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_RUN_ID",
    "GITHUB_REPOSITORY",
    "RUNNER_OS",
  ]) {
    await assert.rejects(
      resolveExecutionPlan("unit", { ...hosted, [key]: "", CI: "true" }),
      /runner context/,
    );
  }
  const plan = await resolveExecutionPlan("unit", hosted);
  assert.equal(plan.hosted, true);
  assert.equal(plan.workers, 2);
  assert.equal(plan.browserWorkers, 1);
});

test("an alternate or missing configuration cannot relax an existing host policy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "BabylonSlate"));
  await writeFile(
    join(directory, "BabylonSlate/local-resources.json"),
    JSON.stringify({ version: 1, profile: "low-memory", reserveGiB: 4.5 }),
  );
  const alternative = join(directory, "worktree.json");
  await writeFile(
    alternative,
    JSON.stringify({ version: 1, profile: "standard", reserveGiB: 1 }),
  );
  for (const path of [alternative, join(directory, "absent.json")]) {
    const plan = await resolveExecutionPlan("unit", {
      LOCALAPPDATA: directory,
      BL_LOCAL_RESOURCE_CONFIG: path,
      BL_TEST_PROFILE: "fast",
    });
    assert.equal(plan.workers, 1);
    assert.equal(plan.config.maxRoots, 1);
    assert.equal(plan.config.capacity.reserveGiB, 4.5);
  }
});
