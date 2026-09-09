import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { repoRoot } from "./process-runner.mjs";
import { buildInputState } from "./source-state.mjs";
import { runPnpm, runStage } from "./test-runner.mjs";
import { readLocalResourceConfig } from "./local-resource-config.mjs";
import {
  buildEnvironmentFingerprint,
  findLocalArtifact,
  findSharedArtifact,
  publishLocalArtifact,
  publishSharedArtifact,
  verifyArtifactFiles,
} from "./shared-test-artifacts.mjs";

export function artifactIdentity(source, configuration = {}) {
  const inputs = {
    version: 2,
    source: source.digest,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    base: "/",
    testMode: true,
    ...configuration,
  };
  return {
    ...inputs,
    commit: source.commit,
    key: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
  };
}
export function verifyArtifactIdentity(actual, expected) {
  return Boolean(
    actual?.key &&
    actual.key === expected.key &&
    actual.source === expected.source &&
    actual.testMode === true &&
    actual.base === expected.base &&
    actual.node === expected.node &&
    actual.platform === expected.platform &&
    actual.arch === expected.arch &&
    actual.environment === expected.environment,
  );
}

async function validArtifact(directory, expected) {
  try {
    const actual = JSON.parse(
      await readFile(join(directory, ".test-build.json"), "utf8"),
    );
    return (
      verifyArtifactIdentity(actual, expected) &&
      (await verifyArtifactFiles(directory, actual))
    );
  } catch {
    return false;
  }
}

async function currentIdentity(environment) {
  return artifactIdentity(await buildInputState(repoRoot), {
    environment: await buildEnvironmentFingerprint(repoRoot, environment),
  });
}

async function assertUnchanged(expected, environment, message) {
  if (!verifyArtifactIdentity(await currentIdentity(environment), expected))
    throw new Error(message);
}

async function sharedCache(environment) {
  if (environment.CI === "true") return null;
  return (await readLocalResourceConfig(environment)).cacheDirectory;
}

export async function buildTestArtifact(options = {}) {
  const environment = { ...process.env, ...options.env };
  const identity = await currentIdentity(environment);
  const root = join(repoRoot, ".cache", "test-build");
  const cache = await sharedCache(environment);
  const local = await findLocalArtifact(root, identity, validArtifact);
  const cached =
    local ?? (await findSharedArtifact(cache, identity, validArtifact));
  if (cached) {
    await assertUnchanged(
      identity,
      environment,
      "Source changed during build cache lookup",
    );
    if (local)
      await publishSharedArtifact(cache, local, identity, validArtifact);
    await assertUnchanged(
      identity,
      environment,
      "Source changed during build cache lookup",
    );
    return { directory: cached, identity, cached: true };
  }
  // The build lease serializes writes to player/dist and editor/dist across local callers.
  const resultPath = join(root, `.request-${randomUUID()}.json`);
  const env = {
    ...options.env,
    VITE_TEST_MODE: "true",
    VITE_BASE_PATH: "/",
    // Git Bash must not rewrite the URL base to its Windows installation path.
    MSYS2_ENV_CONV_EXCL: [environment.MSYS2_ENV_CONV_EXCL, "VITE_BASE_PATH"]
      .filter(Boolean)
      .join(";"),
    BL_TEST_BUILD_DESTINATION: join(root, identity.key),
    BL_TEST_BUILD_IDENTITY: JSON.stringify(identity),
    BL_TEST_BUILD_RESULT: resultPath,
  };
  try {
    await runStage(
      "build",
      process.execPath,
      [join(repoRoot, "scripts", "build-test-artifact.mjs")],
      { ...options, env },
    );
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (!(await validArtifact(result.directory, identity)))
      throw new Error(
        "Test artifact was not published with the requested identity",
      );
    await assertUnchanged(
      identity,
      environment,
      "Source changed during the build; artifact rejected",
    );
    return { directory: result.directory, identity, cached: result.cached };
  } finally {
    await rm(resultPath, { force: true });
  }
}

export async function buildOwnedArtifact() {
  const directory = process.env.BL_TEST_BUILD_DESTINATION;
  const expected = JSON.parse(process.env.BL_TEST_BUILD_IDENTITY ?? "null");
  const resultPath = process.env.BL_TEST_BUILD_RESULT;
  const root = resolve(repoRoot, ".cache", "test-build");
  if (
    !directory ||
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected.key) ||
    resolve(directory) !== join(root, expected.key) ||
    !resultPath ||
    dirname(resolve(resultPath)) !== root ||
    !/^\.request-[a-f0-9-]+\.json$/.test(basename(resultPath))
  )
    throw new Error("Invalid build destination");
  // This child starts only after admission. Check current inputs before any hit,
  // including output a different worktree published while this one was queued.
  await assertUnchanged(
    expected,
    process.env,
    "Source changed while the build was queued",
  );
  const cache = await sharedCache(process.env);
  const report = async (published, cached) => {
    await mkdir(root, { recursive: true });
    await writeFile(
      resultPath,
      JSON.stringify({ directory: published, cached }) + "\n",
    );
  };
  const cached =
    (await findLocalArtifact(root, expected, validArtifact)) ??
    (await findSharedArtifact(cache, expected, validArtifact));
  if (cached) {
    await assertUnchanged(
      expected,
      process.env,
      "Source changed while the build was queued",
    );
    await report(cached, true);
    return;
  }
  // CI static already typechecked both apps; local standalone builds include typechecks.
  if (process.env.CI === "true" && process.env.BL_TEST_TYPECHECKED === "1") {
    await runPnpm("build", ["--filter", "player", "exec", "vite", "build"]);
    await runPnpm("build", ["--filter", "editor", "exec", "vite", "build"]);
  } else await runPnpm("build", ["--filter", "editor", "build"]);
  const unchanged = () =>
    assertUnchanged(
      expected,
      process.env,
      "Source changed during the build; artifact rejected",
    );
  await unchanged();
  const published = await publishLocalArtifact(
    join(repoRoot, "apps", "editor", "dist"),
    root,
    expected,
    validArtifact,
    unchanged,
  );
  await publishSharedArtifact(cache, published, expected, validArtifact);
  await writeFile(
    join(root, "latest.json"),
    JSON.stringify({ directory: published, identity: expected }) + "\n",
  );
  await report(published, false);
}

export async function runBrowserTests(args, options = {}) {
  const environment = { ...process.env, ...options.env };
  let artifact;
  if (environment.BL_TEST_ARTIFACT) {
    const directory = resolve(repoRoot, environment.BL_TEST_ARTIFACT);
    const identity = await currentIdentity(environment);
    if (!(await validArtifact(directory, identity)))
      throw new Error(
        "Downloaded test artifact does not match this source and toolchain",
      );
    artifact = { directory, identity };
  } else artifact = await buildTestArtifact(options);
  return runStage(
    "browser",
    process.execPath,
    [
      join(repoRoot, "scripts", "browser-session.mjs"),
      artifact.directory,
      ...args,
    ],
    options,
  );
}
