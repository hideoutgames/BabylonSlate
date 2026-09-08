import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./process-runner.mjs";
import { gitOutput, sourceState } from "./source-state.mjs";
import { publish } from "./resource-admission.mjs";

async function toolchain(cwd) {
  const require = createRequire(join(cwd, "package.json"));
  const versions = {};
  for (const name of ["vitest", "typescript", "eslint", "@playwright/test"]) {
    try {
      versions[name] = JSON.parse(
        await readFile(require.resolve(`${name}/package.json`), "utf8"),
      ).version;
    } catch {
      versions[name] = null;
    }
  }
  let installedLock = "";
  try {
    installedLock = await readFile(
      join(cwd, "node_modules/.pnpm/lock.yaml"),
      "utf8",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    versions,
    installedLock,
  };
}

/** Result reuse is never used by CI. Repository-reading tests also key on HEAD. */
export async function cachedVerificationPhase(phase, execute, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? process.env;
  const emit =
    options.emit ??
    ((record) => process.stdout.write(JSON.stringify(record) + "\n"));
  if (env.CI === "true" || env.BL_VERIFY_CACHE === "0") {
    await execute();
    return { cached: false };
  }
  const initial = await sourceState(cwd);
  const executionInputs = async () =>
    JSON.stringify({
      toolchain: options.toolchain ?? (await toolchain(cwd)),
      env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    });
  const executionIdentity = await executionInputs();
  const unchanged = async () => {
    const final = await sourceState(cwd);
    if (initial.digest !== final.digest)
      throw new Error(`Source changed during ${phase.id}`);
    if (executionIdentity !== (await executionInputs()))
      throw new Error(`Verification inputs changed during ${phase.id}`);
    return final;
  };
  let inputs = initial.digest;
  if (phase.scope === "typecheck" && initial.clean) {
    // Workspace tsc inputs include code, tests, assets, manifests and root config.
    // Browser scenarios and prose are not compiled by workspace typechecks.
    inputs = await gitOutput(cwd, [
      "ls-files",
      "--stage",
      "-z",
      "--",
      ".",
      ":(glob,exclude)e2e/**",
      ":(glob,exclude)**/*.md",
    ]);
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        phase,
        inputs,
        executionIdentity,
      }),
    )
    .digest("hex");
  const directory = join(cwd, ".cache/verification");
  const path = join(directory, `${key}.json`);
  if (initial.clean) {
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record.key === key && record.status === "success") {
        await unchanged();
        emit({ event: "phase-cache", phase: phase.id, cached: true });
        return { cached: true };
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
  emit({ event: "phase-cache", phase: phase.id, cached: false });
  await execute();
  const final = await unchanged();
  if (initial.clean && final.clean) {
    await mkdir(directory, { recursive: true });
    await publish(path, { key, status: "success", commit: final.commit });
  }
  return { cached: false };
}
