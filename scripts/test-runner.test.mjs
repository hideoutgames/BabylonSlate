import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editorDomBatches,
  runStage,
  runTests,
  toolingArguments,
  unitProfile,
} from "./test-runner.mjs";
import { resolveExecutionPlan } from "./execution-plan.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireResources } from "./resource-admission.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    HAPTIC_EXECUTION_POLICY: "local",
    HAPTIC_TEST_PROFILE: "fast",
    LOCALAPPDATA: directory,
    HAPTIC_LOCAL_RESOURCE_CONFIG: config,
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
          HAPTIC_TEST_LEASE: JSON.stringify({
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

test("scoped lint and typecheck preserve the selected files and workspace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scoped lint "));
  const config = join(directory, "resources.json");
  const manager = join(directory, "package-manager.mjs");
  const originalManager = process.env.npm_execpath;
  let lease;
  t.after(async () => {
    if (originalManager === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalManager;
    await lease?.release();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(config, JSON.stringify({ version: 1, profile: "standard" }));
  await writeFile(manager, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const env = { HAPTIC_EXECUTION_POLICY: "local", HAPTIC_TEST_PROFILE: "shared", LOCALAPPDATA: directory, HAPTIC_LOCAL_RESOURCE_CONFIG: config };
  lease = await acquireResources(
    { workers: 3, browsers: 0, memoryGiB: 2 },
    { directory, env, freeMemory: () => 16 * 1024 ** 3 },
  );
  process.env.npm_execpath = manager;
  const options = { capture: true, env: { ...env, HAPTIC_TEST_LEASE: JSON.stringify({ ticket: lease.ticket, token: lease.token }) } };
  // Content-keyed, because a checkout resets modification times.
  const cache = ["--cache", "--cache-strategy", "content", "--cache-location", ".cache/eslint/"];
  const scoped = await runTests("lint", ["scripts/test-runner.mjs"], options);
  assert.deepEqual(JSON.parse(scoped.output), ["exec", "eslint", ...cache, "scripts/test-runner.mjs"]);
  const all = await runTests("lint", [], options);
  assert.deepEqual(JSON.parse(all.output), ["exec", "eslint", ...cache, "."]);
  const types = await runTests("typecheck", ["--filter", "editor", "--noEmit"], options);
  assert.deepEqual(JSON.parse(types.output), ["--workspace-concurrency=1", "--no-sort", "--filter", "editor", "-r", "typecheck", "--noEmit"]);
  const equals = await runTests("typecheck", ["--filter=docs-site"], options);
  assert.deepEqual(JSON.parse(equals.output), ["--workspace-concurrency=1", "--no-sort", "--filter=docs-site", "-r", "typecheck"]);
  await assert.rejects(runTests("typecheck", ["--filter"], options), /requires a workspace selector/);
});

const hostedContext = {
  HAPTIC_EXECUTION_POLICY: "hosted-ci",
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_RUN_ID: "123",
  GITHUB_REPOSITORY: "fixture/repo",
  RUNNER_OS: "Linux",
};

test("hosted CI typechecks four workspaces at once while builds keep their dependency order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hosted typecheck "));
  const manager = join(directory, "package-manager.mjs");
  const originalManager = process.env.npm_execpath;
  t.after(async () => {
    if (originalManager === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalManager;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(manager, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  process.env.npm_execpath = manager;
  // A checkout without the restored ESLint cache, as on a cache miss.
  const options = { capture: true, cwd: directory, env: hostedContext };
  const types = await runTests("typecheck", [], options);
  assert.deepEqual(JSON.parse(types.output), ["--workspace-concurrency=4", "--no-sort", "-r", "typecheck"]);
  const builds = await runTests("build-all", [], options);
  assert.deepEqual(JSON.parse(builds.output), ["--workspace-concurrency=1", "-r", "build"]);
  // Linting threads share the content cache: workers read it and the main thread writes it.
  const cache = ["--cache", "--cache-strategy", "content", "--cache-location", ".cache/eslint/"];
  const cold = await runTests("lint", [], options);
  assert.deepEqual(JSON.parse(cold.output), ["exec", "eslint", ...cache, "--concurrency=4", "."]);
  // A restored cache leaves only changed files, which one thread lints sooner than workers start.
  await mkdir(join(directory, ".cache", "eslint"), { recursive: true });
  const warm = await runTests("lint", [], options);
  assert.deepEqual(JSON.parse(warm.output), ["exec", "eslint", ...cache, "."]);
});

test("hosted CI runs the tooling contract files four at once and local runs one at a time", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tooling concurrency "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Each file waits for the other to start, so only files that run at the same time pass.
  const files = ["first", "second"].map((name) => join(directory, `${name}.test.mjs`));
  for (const [index, file] of files.entries())
    await writeFile(
      file,
      `import { test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
test("meets the other file", async () => {
  writeFileSync(${JSON.stringify(`${file}.started`)}, "");
  const deadline = Date.now() + 10_000;
  while (!existsSync(${JSON.stringify(`${files[1 - index]}.started`)})) {
    if (Date.now() > deadline) throw new Error("the other file never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
`,
    );
  // The nested runner reports as a top-level run, not to this file's runner.
  await runTests("tooling", files, {
    capture: true,
    env: { ...hostedContext, NODE_TEST_CONTEXT: undefined },
  });
  const local = await resolveExecutionPlan("tooling", {
    HAPTIC_EXECUTION_POLICY: "local",
    HAPTIC_LOCAL_RESOURCE_CONFIG: join(directory, "missing.json"),
  });
  assert.deepEqual(toolingArguments([], local), ["--test", "--test-concurrency=1", "scripts/*.test.mjs"]);
});

test("hosted CI runs the editor DOM files in one Vitest run and local runs restart every 50 files", () => {
  const files = Array.from({ length: 103 }, (_, index) => `apps/editor/src/file-${index}.test.tsx`);
  assert.deepEqual(editorDomBatches(files, true), [files]);
  assert.deepEqual(editorDomBatches(files, false), [
    files.slice(0, 50),
    files.slice(50, 100),
    files.slice(100),
  ]);
});

test("a reader that closes early does not strand the stage's reservation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "closed reader "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "resources.json");
  const manager = join(directory, "package-manager.mjs");
  const closed = join(directory, "reader-closed");
  await writeFile(config, JSON.stringify({ version: 1, profile: "standard" }));
  // Like Vitest piped to `head`, the command outlives the reader.
  await writeFile(
    manager,
    `import { existsSync } from "node:fs";
while (!existsSync(${JSON.stringify(closed)}))
  await new Promise((resolve) => setTimeout(resolve, 10));
`,
  );
  const env = {
    HAPTIC_EXECUTION_POLICY: "local",
    HAPTIC_TEST_PROFILE: "shared",
    LOCALAPPDATA: directory,
    HAPTIC_LOCAL_RESOURCE_CONFIG: config,
  };
  const lease = await acquireResources(
    { workers: 3, browsers: 0, memoryGiB: 2 },
    { directory, env, freeMemory: () => 16 * 1024 ** 3 },
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./run-tests.mjs", import.meta.url)), "lint"],
    {
      env: {
        ...process.env,
        ...env,
        npm_execpath: manager,
        HAPTIC_TEST_LEASE: JSON.stringify({
          ticket: lease.ticket,
          token: lease.token,
        }),
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  child.stdout.once("data", () => child.stdout.destroy());
  // Only a closed pipe can fail the command's later progress writes.
  child.stdout.once("close", () => writeFileSync(closed, ""));
  await new Promise((resolve) => child.once("exit", resolve));
  // A stranded nested scope makes the owner's release fail.
  await lease.release();
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
      env: { LOCALAPPDATA: directory, HAPTIC_LOCAL_RESOURCE_CONFIG: config },
      freeMemory: () => 16 * 1024 ** 3,
    },
  );
  for (const [env, expected] of [
    [{ HAPTIC_TEST_PROFILE: "fast", CI: "" }, ["2", "2"]],
    [{ HAPTIC_TEST_PROFILE: "fast", CI: "true" }, ["2", "2"]],
    [
      { HAPTIC_TEST_PROFILE: "fast", CI: "true", HAPTIC_LOCAL_RESOURCE_CONFIG: low },
      ["1", "1"],
    ],
    [
      {
        HAPTIC_EXECUTION_POLICY: "hosted-ci",
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_RUN_ID: "123",
        GITHUB_REPOSITORY: "fixture/repo",
        RUNNER_OS: "Linux",
      },
      ["4", "1"],
    ],
  ]) {
    const result = await runStage(
      "unit",
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify([process.env.VITEST_MAX_WORKERS,process.env.HAPTIC_TEST_BROWSER_WORKERS]))",
      ],
      {
        env: {
          HAPTIC_EXECUTION_POLICY: "local",
          LOCALAPPDATA: directory,
          HAPTIC_LOCAL_RESOURCE_CONFIG: config,
          ...env,
          HAPTIC_TEST_LEASE: JSON.stringify({
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
