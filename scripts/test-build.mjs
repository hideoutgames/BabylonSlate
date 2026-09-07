import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRoot } from "./process-runner.mjs";
import { buildInputState } from "./source-state.mjs";
import { runPnpm, runStage } from "./test-runner.mjs";

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
    actual.base === expected.base,
  );
}

async function validArtifact(directory, expected) {
  try {
    const actual = JSON.parse(
      await readFile(join(directory, ".test-build.json"), "utf8"),
    );
    await access(join(directory, "index.html"));
    return verifyArtifactIdentity(actual, expected);
  } catch {
    return false;
  }
}

export async function buildTestArtifact(options = {}) {
  const initial = await buildInputState(repoRoot);
  const identity = artifactIdentity(initial);
  const directory = join(repoRoot, ".cache", "test-build", identity.key);
  if (await validArtifact(directory, identity))
    return { directory, identity, cached: true };
  // The build lease serializes writes to player/dist and editor/dist across local callers.
  const env = {
    VITE_TEST_MODE: "true",
    VITE_BASE_PATH: "/",
    // Git Bash must not rewrite the URL base to its Windows installation path.
    MSYS2_ENV_CONV_EXCL: [process.env.MSYS2_ENV_CONV_EXCL, "VITE_BASE_PATH"]
      .filter(Boolean)
      .join(";"),
    BL_TEST_BUILD_DESTINATION: directory,
    BL_TEST_BUILD_IDENTITY: JSON.stringify(identity),
  };
  await runStage(
    "build",
    process.execPath,
    [join(repoRoot, "scripts", "build-test-artifact.mjs")],
    { ...options, env },
  );
  if (!(await validArtifact(directory, identity)))
    throw new Error(
      "Test artifact was not published with the requested identity",
    );
  return { directory, identity, cached: false };
}

export async function buildOwnedArtifact() {
  const directory = process.env.BL_TEST_BUILD_DESTINATION;
  const expected = JSON.parse(process.env.BL_TEST_BUILD_IDENTITY ?? "null");
  if (
    !directory ||
    !expected ||
    (!resolve(directory).startsWith(
      resolve(repoRoot, ".cache", "test-build") + "/",
    ) &&
      !resolve(directory).startsWith(
        resolve(repoRoot, ".cache", "test-build") + "\\",
      ))
  )
    throw new Error("Invalid build destination");
  if (await validArtifact(directory, expected)) return;
  const initial = artifactIdentity(await buildInputState(repoRoot));
  if (!verifyArtifactIdentity(initial, expected))
    throw new Error("Source changed while the build was queued");
  // CI static already typechecked both apps; local standalone builds include typechecks.
  if (process.env.CI === "true" && process.env.BL_TEST_TYPECHECKED === "1") {
    await runPnpm("build", ["--filter", "player", "exec", "vite", "build"]);
    await runPnpm("build", ["--filter", "editor", "exec", "vite", "build"]);
  } else await runPnpm("build", ["--filter", "editor", "build"]);
  const final = artifactIdentity(await buildInputState(repoRoot));
  if (!verifyArtifactIdentity(final, expected))
    throw new Error("Source changed during the build; artifact rejected");
  await mkdir(directory, { recursive: true });
  await cp(join(repoRoot, "apps", "editor", "dist"), directory, {
    recursive: true,
  });
  // Publication marker is written last; incomplete directories are never reused.
  await writeFile(
    join(directory, ".test-build.json"),
    JSON.stringify(expected, null, 2) + "\n",
  );
  await mkdir(join(repoRoot, ".cache", "test-build"), { recursive: true });
  await writeFile(
    join(repoRoot, ".cache", "test-build", "latest.json"),
    JSON.stringify({ directory, identity: expected }) + "\n",
  );
}

export async function runBrowserTests(args, options = {}) {
  let artifact;
  if (process.env.BL_TEST_ARTIFACT) {
    const directory = resolve(repoRoot, process.env.BL_TEST_ARTIFACT);
    const identity = artifactIdentity(await buildInputState(repoRoot));
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
