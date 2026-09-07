import { test } from "node:test";
import assert from "node:assert/strict";
import { relative } from "node:path";
import { gitOutput } from "./source-state.mjs";
import { repoRoot, runCommand, toolCli } from "./process-runner.mjs";

test("Vitest selects each authored test once and never follows workspace links into dependency tests", async () => {
  const result = await runCommand(
    process.execPath,
    [
      toolCli("vitest"),
      "list",
      "--config",
      "vitest.workspace.ts",
      "--filesOnly",
      "--json",
    ],
    {
      capture: true,
      env: { ...process.env, VITEST_COVERAGE: "0" },
    },
  );
  assert.equal(result.code, 0, result.output);
  const actual = JSON.parse(result.output)
    .map((row) => relative(repoRoot, row.file).replaceAll("\\", "/"))
    .sort();
  assert.equal(
    actual.some((path) => path.includes("node_modules/")),
    false,
    "Dependency tests must remain excluded",
  );
  assert.equal(
    new Set(actual).size,
    actual.length,
    "No file may execute in two projects",
  );
  const files = (
    await gitOutput(repoRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  ).split("\0");
  const deleted = new Set(
    (await gitOutput(repoRoot, ["ls-files", "--deleted", "-z"])).split("\0"),
  );
  const expected = files.filter(
    (path) =>
      /^(apps|packages)\/.*\.test\.tsx?$/.test(path) && !deleted.has(path),
  );
  expected.push("playwright.config.test.ts");
  assert.deepEqual(actual, [...new Set(expected)].sort());
});
