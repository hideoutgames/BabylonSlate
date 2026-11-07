import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

test("lint skips the vendored decoder builds and still reads the editor's own public scripts", async () => {
  const scripts = execFileSync(
    "git",
    ["ls-files", "apps/editor/public/*.js", "apps/editor/public/**/*.js"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const linted = [];
  for (const file of scripts)
    if (!(await eslint.isPathIgnored(file))) linted.push(file);
  // Everything else under public/ is a third-party decoder or encoder build.
  assert.deepEqual(linted.sort(), [
    "apps/editor/public/basis/encode-worker.js",
    "apps/editor/public/coi-serviceworker.js",
  ]);
});
