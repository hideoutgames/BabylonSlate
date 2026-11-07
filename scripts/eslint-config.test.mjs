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

test("tests, like production code, may take only types from the Babylon package root", async () => {
  const source = [
    'import { Scene } from "@babylonjs/core";',
    'import type { Mesh } from "@babylonjs/core";',
    'import { NullEngine } from "@babylonjs/core/Engines/nullEngine";',
    "export const scene: Scene = new Scene(new NullEngine());",
    "export type Visual = Mesh;",
    "",
  ].join("\n");
  // Each package whose tests load Babylon, and one production file for comparison.
  for (const filePath of [
    "packages/render/src/example.test.ts",
    "packages/physics/src/example.test.ts",
    "apps/player/src/example.test.ts",
    "apps/editor/src/example.test.tsx",
    "packages/render/src/example.ts",
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    const rootImports = result.messages.filter(
      (message) => message.ruleId === "no-restricted-imports",
    );
    // Only the value import on line 1: a root value import loads and registers all of Babylon.
    assert.deepEqual(
      rootImports.map((message) => message.line),
      [1],
      `${filePath}: ${JSON.stringify(result.messages)}`,
    );
  }
});
