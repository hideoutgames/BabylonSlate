import { test } from "node:test";
import assert from "node:assert/strict";

const project = async (name) =>
  (await import(new URL(`../vitest.projects.${name}.ts`, import.meta.url))).default.test;

test("only the jsdom project processes stylesheets, since only its tests read computed styles", async () => {
  // Role queries and components read the stylesheets' hiding and overflow rules in jsdom.
  assert.equal((await project("jsdom")).css, true);
  // The node project has no DOM to read them, so its stylesheet imports stay Vitest's empty stub.
  assert.equal((await project("node")).css, undefined);
  assert.equal((await project("babylon")).css, undefined);
});
