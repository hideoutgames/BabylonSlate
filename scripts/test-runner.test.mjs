import { test } from "node:test";
import assert from "node:assert/strict";
import { runStage, unitProfile } from "./test-runner.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireResources } from "./resource-admission.mjs";
import { existsSync, writeFileSync } from "node:fs";

test("a stricter host policy before launch rejects stale worker settings and releases the nested scope", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "runner policy change "));
  const config = join(directory, "resources.json");
  const marker = join(directory, "child-started");
  let lease;
  t.after(async () => {
    await lease?.release();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(config, JSON.stringify({ version: 1, profile: "standard" }));
  const env = {
    BL_EXECUTION_POLICY: "local",
    BL_TEST_PROFILE: "fast",
    LOCALAPPDATA: directory,
    BL_LOCAL_RESOURCE_CONFIG: config,
  };
  lease = await acquireResources(
    { workers: 3, browsers: 1, memoryGiB: 6 },
    { directory, env, freeMemory: () => 16 * 1024 ** 3 },
  );
  await assert.rejects(
    runStage(
      "unit",
      process.execPath,
      () => {
        // Deterministically change the host after resolution, before admission.
        writeFileSync(
          config,
          JSON.stringify({ version: 1, profile: "low-memory" }),
        );
        return [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'started')",
          marker,
        ];
      },
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
    ),
    /policy became more restrictive/,
  );
  assert.equal(existsSync(marker), false);
  // A leaked nested claim would prevent the parent from releasing.
  await lease.release();
  lease = null;
});

test("explicit Node and docs tests use the lighter unit workload", () => {
  assert.equal(unitProfile(["--project", "node", "packages/core"]), "unit");
  assert.equal(unitProfile(["--project=node", "packages/core"]), "unit");
  assert.equal(unitProfile(["apps/docs/src/sidebar.test.ts"]), "unit");
  assert.equal(unitProfile(["playwright.config.test.ts"]), "unit");
  assert.equal(unitProfile(["apps/editor/src/panel.test.tsx"]), "focused");
  assert.equal(unitProfile([]), "dom");
});

test("one resolved policy reaches child worker settings regardless of local CI flags", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "runner lease "));
  let lease;
  t.after(async () => {
    await lease?.release();
    await rm(directory, { recursive: true, force: true });
  });
  const config = join(directory, "standard.json");
  const low = join(directory, "low.json");
  await writeFile(config, JSON.stringify({ version: 1, profile: "standard" }));
  await writeFile(low, JSON.stringify({ version: 1, profile: "low-memory" }));
  lease = await acquireResources(
    { workers: 3, browsers: 1, memoryGiB: 6 },
    {
      directory,
      env: { LOCALAPPDATA: directory, BL_LOCAL_RESOURCE_CONFIG: config },
      freeMemory: () => 16 * 1024 ** 3,
    },
  );
  for (const [env, expected] of [
    [{ BL_TEST_PROFILE: "fast", CI: "" }, ["2", "2"]],
    [{ BL_TEST_PROFILE: "fast", CI: "true" }, ["2", "2"]],
    [
      { BL_TEST_PROFILE: "fast", CI: "true", BL_LOCAL_RESOURCE_CONFIG: low },
      ["1", "1"],
    ],
    [
      {
        BL_EXECUTION_POLICY: "hosted-ci",
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_RUN_ID: "123",
        GITHUB_REPOSITORY: "fixture/repo",
        RUNNER_OS: "Linux",
      },
      ["2", "1"],
    ],
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
          BL_EXECUTION_POLICY: "local",
          LOCALAPPDATA: directory,
          BL_LOCAL_RESOURCE_CONFIG: config,
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
