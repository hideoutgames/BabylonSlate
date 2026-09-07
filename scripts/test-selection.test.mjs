import { test } from "node:test";
import assert from "node:assert/strict";
import { selectChecks } from "./test-selection.mjs";

const packages = [
  { name: "core", path: "packages/core", dependencies: [] },
  { name: "render", path: "packages/render", dependencies: ["core"] },
  { name: "editor", path: "apps/editor", dependencies: ["render"] },
  { name: "other", path: "packages/other", dependencies: [] },
];

test("a pure change selects its consumers without starting a browser", () => {
  const result = selectChecks(["packages/core/src/math.ts"], packages);
  assert.deepEqual(result.packages, ["core", "editor", "render"]);
  assert.deepEqual(result.e2e, []);
  assert.equal(result.full, false);
});

test("browser integration changes select smoke coverage; test-only changes do not", () => {
  assert.deepEqual(
    selectChecks(["packages/render/src/create-engine.ts"], packages).e2e,
    [
      "e2e/editor-smoke.spec.ts",
      "e2e/p4-play.spec.ts",
      "e2e/p14-preview-build.spec.ts",
    ],
  );
  assert.deepEqual(
    selectChecks(["packages/render/src/create-engine.test.ts"], packages).e2e,
    [],
  );
});

test("documentation selects its build and deleted files remain valid inputs", () => {
  const result = selectChecks(
    ["docs/architecture/testing.md", "packages/other/src/deleted.ts"],
    packages,
  );
  assert.equal(result.docs, true);
  assert.deepEqual(result.packages, ["other"]);
});

test("unknown paths and verification infrastructure fail closed to the complete gate", () => {
  for (const path of [
    "new-system/source.ts",
    "scripts/test-selection.mjs",
    "vitest.workspace.ts",
    ".github/workflows/verify.yml",
    "pnpm-lock.yaml",
  ]) {
    assert.equal(selectChecks([path], packages).full, true, path);
  }
});

test("cycles terminate and a changed consumer does not select unrelated dependencies", () => {
  const cyclic = [
    ...packages,
    { name: "cycle", path: "packages/cycle", dependencies: ["editor"] },
  ];
  cyclic[2] = { ...cyclic[2], dependencies: ["render", "cycle"] };
  assert.deepEqual(
    selectChecks(["apps/editor/src/lib/foo.test.ts"], cyclic).packages,
    ["cycle", "editor"],
  );
});
