#!/usr/bin/env node
// Typechecks the editor's TypeScript programs as separate `tsc -b` processes, one after another, so peak memory is the
// largest program's rather than their sum. Each program reloads Babylon's declarations and most workspace sources, so
// one process holding all of them needed over 4 GB.
//
//   node scripts/typecheck.mjs            app, unit tests, Node-side config and tests, Playwright specs
//   node scripts/typecheck.mjs app        only the shipped app (the production build)
//
// Every selected program runs even after one fails, so one run reports every error; the exit code is nonzero when any
// failed. The unit test program is about 2.8 GB and the app about 2.1 GB, more than Node's default heap on a 16 GB
// host (about 2 GB), so each process gets an explicit heap limit here rather than through NODE_OPTIONS in every caller.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TYPECHECK_PROGRAMS = {
  app: "tsconfig.app.json",
  test: "tsconfig.test.json",
  node: "tsconfig.node.json",
  e2e: "tsconfig.e2e.json",
};
const TYPECHECK_HEAP_MB = 4096;

const editorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(join(editorRoot, "package.json")).resolve("typescript/bin/tsc");

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in TYPECHECK_PROGRAMS));
if (unknown.length > 0) {
  console.error(`Unknown typecheck program: ${unknown.join(", ")}. Choose from ${Object.keys(TYPECHECK_PROGRAMS).join(", ")}.`);
  process.exit(2);
}

const failed = [];
for (const name of requested.length > 0 ? requested : Object.keys(TYPECHECK_PROGRAMS)) {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${TYPECHECK_HEAP_MB}`, tsc, "-b", TYPECHECK_PROGRAMS[name]],
    { cwd: editorRoot, stdio: "inherit" },
  );
  if (result.status !== 0) failed.push(`${name} (${result.error?.message ?? result.signal ?? `exit ${result.status}`})`);
}
if (failed.length > 0) {
  console.error(`Editor typecheck failed: ${failed.join(", ")}.`);
  process.exit(1);
}
