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
import { fullVerification, runPnpm, runTests } from "./test-runner.mjs";

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
  const selection = selectChecks(files, workspace);
  const report = {
    base,
    initial,
    files,
    selection,
    deliveryEligible: false,
    status: "running",
    commands: [],
  };
  const reportPath = join(directory, "result.json");
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await save();
  process.stdout.write(
    JSON.stringify({
      event: "selection",
      full: selection.full,
      packages: selection.packages,
      e2e: selection.e2e,
      reportPath,
    }) + "\n",
  );
  try {
    if (selection.full) {
      report.commands.push(["verify"]);
      await fullVerification(options);
    } else {
      const selected = workspace.filter((pkg) =>
        selection.packages.includes(pkg.name),
      );
      for (const pkg of selected) {
        if (pkg.scripts.typecheck) {
          const command = ["--filter", pkg.name, "typecheck"];
          report.commands.push(command);
          await runPnpm("build", command, options);
        }
      }
      const lint = [];
      for (const file of files.filter((file) => /\.[cm]?[jt]sx?$/.test(file))) {
        try {
          await access(join(repoRoot, file));
          lint.push(file);
        } catch {
          /* deleted */
        }
      }
      if (lint.length) {
        report.commands.push(["exec", "eslint", ...lint]);
        await runPnpm("unit", ["exec", "eslint", ...lint], options);
      }
      // Discovery covers split environments and packages without authored tests.
      const paths = selected.map((pkg) => pkg.path);
      if (paths.length) {
        report.commands.push(["test", ...paths]);
        await runTests("unit", [...paths, "--passWithNoTests"], options);
      }
      const browser = [];
      for (const file of selection.e2e) {
        try {
          await access(join(repoRoot, file));
          browser.push(file);
        } catch {
          if (!files.includes(file))
            throw new Error(`Browser mapping points to missing ${file}`);
        }
      }
      if (browser.length) {
        report.commands.push(["test:e2e", ...browser]);
        await runTests("e2e", browser, options);
      }
      if (selection.docs) {
        report.commands.push(["--filter", "docs-site", "build"]);
        await runPnpm("build", ["--filter", "docs-site", "build"], options);
      }
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
