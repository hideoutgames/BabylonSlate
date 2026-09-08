import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandSignal, repoRoot } from "./process-runner.mjs";
import { changedFiles, gitOutput, sourceState } from "./source-state.mjs";
import { selectChecks } from "./test-selection.mjs";
import { runPnpm, runTests } from "./test-runner.mjs";
import { cachedVerificationPhase } from "./verification-cache.mjs";

export async function workspacePackages() {
  const packages = [];
  for (const parent of ["packages", "apps"]) {
    for (const entry of await readdir(join(repoRoot, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const path = `${parent}/${entry.name}`;
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(join(repoRoot, path, "package.json"), "utf8"),
        );
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      packages.push({
        name: manifest.name,
        path,
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.peerDependencies,
        }),
        scripts: manifest.scripts ?? {},
      });
    }
  }
  return packages;
}

export function availablePreflightTests(files, deleted = new Set()) {
  return [...new Set(files)].filter(
    (file) =>
      !deleted.has(file) &&
      /\.test\.[cm]?[jt]sx?$/.test(file) &&
      (/^(apps|packages|scripts)\//.test(file) ||
        file === "playwright.config.test.ts"),
  );
}

/** A local preflight must never silently dispatch coverage, all editor tests, or browsers. */
export function preflightPhases(selection, workspace, lint) {
  const phases = [];
  if (selection.toolingTests.length)
    phases.push({
      id: "tooling",
      runner: "tests",
      mode: "tooling",
      args: selection.toolingTests,
    });
  if (selection.distributionTests.length)
    phases.push({
      id: "distribution",
      runner: "tests",
      mode: "tooling",
      args: selection.distributionTests,
    });
  const packages = workspace.filter(
    (pkg) => selection.packages.includes(pkg.name) && pkg.scripts.typecheck,
  );
  if (packages.length)
    phases.push({
      id: "typecheck",
      runner: "pnpm",
      profile: "typecheck",
      scope: "typecheck",
      args: [
        "--workspace-concurrency=1",
        ...packages.flatMap((pkg) => ["--filter", pkg.name]),
        "-r",
        "typecheck",
      ],
    });
  if (lint.length)
    phases.push({
      id: "lint",
      runner: "pnpm",
      profile: "unit",
      args: ["exec", "eslint", ...lint],
    });
  for (let index = 0; index < selection.unitTests.length; index += 50)
    phases.push({
      id: `unit-${index / 50 + 1}`,
      runner: "tests",
      mode: "unit",
      args: selection.unitTests.slice(index, index + 50),
    });
  if (selection.docs)
    phases.push({
      id: "docs",
      runner: "pnpm",
      profile: "docs",
      args: ["--filter", "docs-site", "build"],
    });
  return phases;
}

export async function verifyLocal(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "babylonslate-verify-local-"));
  const initial = await sourceState(repoRoot);
  let base;
  for (const ref of ["origin/main", "main"]) {
    try {
      base = (await gitOutput(repoRoot, ["merge-base", "HEAD", ref])).trim();
      break;
    } catch {
      /* Try local main. */
    }
  }
  if (!base)
    throw new Error(
      "Cannot find a merge base with main; fetch origin/main before verification",
    );
  const files = await changedFiles(repoRoot, base);
  const workspace = await workspacePackages();
  const deleted = new Set(
    (await gitOutput(repoRoot, ["ls-files", "--deleted", "-z"])).split("\0"),
  );
  const availableTests = availablePreflightTests(
    (
      await gitOutput(repoRoot, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    ).split("\0"),
    deleted,
  );
  const selection = selectChecks(files, workspace, availableTests);
  const lint = [];
  for (const file of files.filter((file) => /\.[cm]?[jt]sx?$/.test(file))) {
    try {
      await access(join(repoRoot, file));
      lint.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const report = {
    scope: "preflight",
    base,
    initial,
    files,
    selection,
    deliveryEligible: false,
    status: "running",
    commands: [],
    requiredCi: ["static", "unit", "all seven e2e shards"],
  };
  const reportPath = join(directory, "result.json");
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await save();
  process.stdout.write(
    JSON.stringify({
      event: "selection",
      scope: "preflight",
      ...selection,
      reportPath,
    }) + "\n",
  );
  try {
    await gitOutput(repoRoot, ["diff", "--check", base]);
    for (const phase of preflightPhases(selection, workspace, lint)) {
      report.commands.push(phase);
      const result = await cachedVerificationPhase(
        phase,
        () =>
          phase.runner === "tests"
            ? runTests(phase.mode, phase.args, options)
            : runPnpm(phase.profile, phase.args, options),
        { env: { ...process.env, ...options.env } },
      );
      phase.cached = result.cached;
      await save();
    }
    report.final = await sourceState(repoRoot);
    if (initial.digest !== report.final.digest)
      throw new Error("Source changed during local verification");
    report.deliveryEligible = initial.clean && report.final.clean;
    report.status = "success";
  } catch (error) {
    report.status = "failure";
    throw error;
  } finally {
    await save();
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const lifetime = commandSignal();
  try {
    if (process.argv.length !== 2)
      throw new Error(
        "verify:local does not accept filters; use pnpm test for focused checks",
      );
    await verifyLocal({ signal: lifetime.signal });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  } finally {
    lifetime.dispose();
  }
}
