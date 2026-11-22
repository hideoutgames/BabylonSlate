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

test("packages/physics may import @babylonjs/havok only and rejects @babylonjs/core", async () => {
  const source = [
    'import type { HavokPhysicsWithBindings } from "@babylonjs/havok";',
    'import { Scene } from "@babylonjs/core";',
    'import type { Mesh } from "@babylonjs/core";',
    'import { NullEngine } from "@babylonjs/core/Engines/nullEngine";',
    "export type H = HavokPhysicsWithBindings;",
    "export const scene: Scene = new Scene(new NullEngine());",
    "export type Visual = Mesh;",
    "",
  ].join("\n");
  for (const filePath of [
    "packages/physics/src/example.ts",
    "packages/physics/src/example.test.ts",
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    const restricted = result.messages.filter(
      (message) => message.ruleId === "no-restricted-imports",
    );
    assert.deepEqual(
      restricted.map((message) => message.line),
      [2, 3, 4],
      `${filePath}: ${JSON.stringify(result.messages)}`,
    );
  }
});

test("workspaces import each other by package name, never by a relative path into another workspace", async () => {
  const rejected = [
    ["apps/editor/src/lib/example.test.ts", 'import { x } from "../../../../packages/vfs/src/test-support/memory-opfs";'],
    ["apps/player/vite.config.ts", 'import { x } from "../editor/vite-helper";'],
    ["apps/desktop/scripts/example.mjs", 'import { x } from "../../../packages/exporter/src/native-android.ts";'],
    ["packages/build-config/src/example.ts", 'import { x } from "../../core/src/index";'],
    ["packages/render/src/example.test.ts", 'import { x } from "../../assets/src/hasset";'],
  ];
  for (const [filePath, line] of rejected) {
    const [result] = await eslint.lintText(`${line}\nexport { x };\n`, { filePath });
    const restricted = result.messages.filter((message) => message.ruleId === "no-restricted-imports");
    assert.equal(restricted.length, 1, `${filePath}: ${JSON.stringify(result.messages)}`);
  }
  const allowed = [
    'import { x } from "@haptic/vfs/test-support/memory-opfs";',
    'import { y } from "../lib/local";',
    'import { z } from "../../../../scripts/distribution/contract.mjs";',
    "export { x, y, z };",
    "",
  ].join("\n");
  const [result] = await eslint.lintText(allowed, { filePath: "apps/editor/src/lib/example.test.ts" });
  assert.deepEqual(result.messages.filter((message) => message.ruleId === "no-restricted-imports"), []);
});
