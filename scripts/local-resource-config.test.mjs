import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireResources, workloadFor } from "./resource-admission.mjs";
import { runStage } from "./test-runner.mjs";

async function fixture(t, config) {
  const directory = await mkdtemp(join(tmpdir(), "local resource config "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "local-resources.json");
  if (config !== undefined) await writeFile(path, JSON.stringify(config));
  return {
    path,
    options: {
      directory: join(directory, "admission"),
      env: { BL_LOCAL_RESOURCE_CONFIG: path },
      freeMemory: () => 5 * 1024 ** 3,
      pollMs: 5,
      timeoutMs: 500,
    },
  };
}

test("one user configuration lets separate callers build with five GiB free", async (t) => {
  const { path, options } = await fixture(t, {
    version: 1,
    profile: "low-memory",
  });
  for (const directory of ["first-worktree", "second-worktree"]) {
    const lease = await acquireResources(workloadFor("build", {}), {
      ...options,
      directory: join(options.directory, directory),
    });
    await lease.release();
  }
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    profile: "low-memory",
  });
});

test("user config can tune headroom without weakening an explicit reservation", async (t) => {
  const { options } = await fixture(t, {
    version: 1,
    profile: "low-memory",
    reserveGiB: 3.5,
  });
  await assert.rejects(
    acquireResources(workloadFor("build", {}), options),
    /deadline/i,
  );
  const lease = await acquireResources(workloadFor("build", {}), {
    ...options,
    freeMemory: () => 5.5 * 1024 ** 3,
  });
  await lease.release();
});

test("invalid machine settings fail before queueing work", async (t) => {
  for (const config of [
    { version: 2, profile: "low-memory" },
    { version: 1, profile: "unbounded" },
    { version: 1, profile: "low-memory", reserveGiB: -1 },
    { version: 1, profile: "low-memory", maxHeavy: 0 },
    { version: 1, profile: "low-memory", maxBypasses: 1.5 },
    { version: 1, profile: "low-memory", reserveGiB: null },
    { version: 1, profile: "low-memory", maxHeavy: null },
    { version: 1, profile: "low-memory", maxBypasses: null },
    { version: 1, profile: "low-memory", cacheDirectory: "relative/cache" },
    { version: 1, profile: "low-memory", reserveGib: 3 },
  ]) {
    const { path, options } = await fixture(t, config);
    await assert.rejects(
      acquireResources(workloadFor("tooling", {}), options),
      (error) =>
        error.message.includes(path) && /configuration/i.test(error.message),
    );
    await assert.rejects(readdir(options.directory), { code: "ENOENT" });
  }
});

test("missing user settings preserve conservative defaults and CI ignores machine settings", async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(
    acquireResources(workloadFor("build", {}), options),
    /deadline/i,
  );
  const { path } = await fixture(t, { version: 999 });
  const lease = await acquireResources(workloadFor("build", {}), {
    ...options,
    env: { CI: "true", BL_LOCAL_RESOURCE_CONFIG: path },
    freeMemory: () => 6 * 1024 ** 3,
  });
  await lease.release();
});

test("all worktrees discover the same per-user config independent of their directory", async (t) => {
  const { path, options } = await fixture(t, {
    version: 1,
    profile: "low-memory",
  });
  const userDirectory = join(options.directory, "user-data");
  await mkdir(join(userDirectory, "BabylonSlate"), { recursive: true });
  await writeFile(
    join(userDirectory, "BabylonSlate", "local-resources.json"),
    await readFile(path),
  );
  const lease = await acquireResources(workloadFor("build", {}), {
    ...options,
    env: { LOCALAPPDATA: userDirectory },
  });
  await lease.release();
});

test("stage-specific config is validated before launching a child; CI remains independent", async (t) => {
  const { path } = await fixture(t, { version: 999 });
  const options = {
    capture: true,
    signal: AbortSignal.timeout(5000),
    env: {
      CI: "",
      BL_TEST_LEASE: "",
      BL_TEST_PROFILE: "shared",
      BL_LOCAL_RESOURCE_CONFIG: path,
    },
  };
  await assert.rejects(
    runStage(
      "tooling",
      process.execPath,
      ["-e", "console.log('ran')"],
      options,
    ),
    (error) =>
      error.message.includes(path) && /configuration/i.test(error.message),
  );
  const result = await runStage(
    "tooling",
    process.execPath,
    ["-e", "console.log('ci')"],
    {
      ...options,
      env: { ...options.env, CI: "true" },
    },
  );
  assert.equal(result.output.trim(), "ci");
});
