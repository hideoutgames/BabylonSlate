import { test } from "node:test";
import assert from "node:assert/strict";
import { selectChecks } from "./test-selection.mjs";

const packages = [
  { name: "core", path: "packages/core", dependencies: [] },
  { name: "render", path: "packages/render", dependencies: ["core"] },
  { name: "editor", path: "apps/editor", dependencies: ["render"] },
  { name: "other", path: "packages/other", dependencies: [] },
];
const tests = [
  "packages/core/src/math.edge-cases.test.ts",
  "packages/core/src/math.test.ts",
  "packages/core/src/unrelated.test.ts",
  "apps/editor/src/panel.test.tsx",
];

test("preflight typechecks consumers but runs only changed and sibling unit tests", () => {
  const result = selectChecks(["packages/core/src/math.ts"], packages, tests);
  assert.deepEqual(result.packages, ["core", "editor", "render"]);
  assert.deepEqual(result.unitTests, tests.slice(0, 2));
  assert.equal(result.tooling, false);
});

test("test edits select the exact existing test and never select a deleted test", () => {
  const result = selectChecks(
    ["apps/editor/src/panel.test.tsx", "apps/editor/src/deleted.test.tsx"],
    packages,
    tests,
  );
  assert.deepEqual(result.unitTests, ["apps/editor/src/panel.test.tsx"]);
});

test("infrastructure and unknown paths select static preflight, not exhaustive tests", () => {
  for (const file of [
    "scripts/test-selection.mjs",
    "vitest.workspace.ts",
    ".github/workflows/verify.yml",
    "pnpm-lock.yaml",
    "new-system/source.ts",
  ]) {
    const result = selectChecks([file], packages, tests);
    assert.equal(result.tooling, true, file);
    assert.deepEqual(
      result.packages,
      ["core", "editor", "other", "render"],
      file,
    );
    assert.deepEqual(result.unitTests, [], file);
    assert.equal(
      result.full,
      undefined,
      "preflight cannot silently expand to the full gate",
    );
  }
});

test("browser changes are left to CI while documentation selects its build", () => {
  const result = selectChecks(
    [
      "e2e/p14-export.spec.ts",
      "e2e/minimal-project.ts",
      "docs/architecture/testing.md",
    ],
    packages,
    tests,
  );
  assert.equal(result.docs, true);
  assert.equal(
    result.tooling,
    true,
    "browser harness changes run the tooling contracts",
  );
  assert.deepEqual(result.unitTests, []);
  assert.equal(
    result.e2e,
    undefined,
    "automatic local preflight must not launch browsers",
  );
});

test("dependency cycles terminate without selecting unrelated packages", () => {
  const cyclic = [
    ...packages,
    { name: "cycle", path: "packages/cycle", dependencies: ["editor"] },
  ];
  cyclic[2] = { ...cyclic[2], dependencies: ["render", "cycle"] };
  assert.deepEqual(
    selectChecks(["apps/editor/src/panel.tsx"], cyclic, tests).packages,
    ["cycle", "editor"],
  );
});
