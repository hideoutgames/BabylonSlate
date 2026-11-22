#!/usr/bin/env node
// Typechecks one workspace's TypeScript projects with incremental build info under `.cache/typecheck/`.
//
// Usage, from a workspace directory (its package script):
//   node ../../scripts/typecheck-incremental.mjs <tsconfig.json> [<tsconfig.json> ...]
//
// Each project runs `tsc -p <config> --noEmit --incremental` with its build info at
// `.cache/typecheck/<workspace path>/<config name>.tsbuildinfo`, every project even after one fails; the exit code is
// the first failure's. Plain `tsc -p` (not `tsc -b`) is what makes reuse sound: it builds the whole program each run
// and compares every file's content hash, sibling workspaces' sources included, with the build info, and reuses a
// file's diagnostics only when neither it nor anything its types depend on changed; changed options invalidate the
// build info. File times play no part. `tsc -b` instead decides a project is up to date from the times of its own
// root files and config alone, so with incremental build info it skips a check that a change in another workspace
// needs.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

/** The `tsc` arguments for each config of the workspace at `cwd`. */
export function typecheckCommands(configs, cwd, root = repoRoot) {
  if (!configs.length) throw new Error("Name at least one tsconfig");
  const workspace = relative(root, cwd).split("\\").join("/");
  if (!workspace || workspace.startsWith(".."))
    throw new Error(`Run from a workspace inside the repository, not ${cwd}`);
  return configs.map((config) => [
    "-p",
    config,
    "--noEmit",
    "--incremental",
    "--tsBuildInfoFile",
    join(root, ".cache", "typecheck", workspace, `${basename(config, ".json")}.tsbuildinfo`),
  ]);
}

/** Runs every project and returns the first failing exit code, or 0. */
export function main(configs, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const tsc =
    options.tsc ?? createRequire(join(cwd, "package.json")).resolve("typescript/bin/tsc");
  let exitCode = 0;
  for (const args of typecheckCommands(configs, cwd, options.root)) {
    mkdirSync(resolve(args.at(-1), ".."), { recursive: true });
    const result = spawnSync(process.execPath, [tsc, ...args], {
      cwd,
      stdio: options.stdio ?? "inherit",
    });
    const code = result.status ?? 1;
    if (code && !exitCode) exitCode = code;
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2));
