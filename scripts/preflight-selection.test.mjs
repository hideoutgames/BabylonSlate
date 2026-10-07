import { test } from "node:test";
import assert from "node:assert/strict";
import { selectChecks } from "./test-selection.mjs";

const packages = [
  { name: "core", path: "packages/core", dependencies: [] },
  { name: "render", path: "packages/render", dependencies: ["core"] },
  { name: "editor", path: "apps/editor", dependencies: ["render"] },
  { name: "docs-site", path: "apps/docs", dependencies: [] },
  { name: "other", path: "packages/other", dependencies: [] },
];
const tests = [
  "packages/core/src/math.edge-cases.test.ts",
  "packages/core/src/math.test.ts",
  "packages/core/src/unrelated.test.ts",
  "packages/test-kit/src/public-hygiene.test.ts",
  "apps/docs/src/sidebar.test.ts",
  "apps/editor/src/panel.test.tsx",
  "playwright.config.test.ts",
  "scripts/browser-partition.test.mjs",
  "scripts/browser-server.test.mjs",
  "scripts/preflight-selection.test.mjs",
  "scripts/test-build.test.mjs",
  "scripts/test-runner.test.mjs",
  "scripts/verification-policy.test.mjs",
  "scripts/verify-local.test.mjs",
  "scripts/distribution/apple-assets.test.mjs",
  "scripts/distribution/workflow.test.mjs",
];

test("preflight typechecks only the changed package and runs sibling unit tests", () => {
  const result = selectChecks(["packages/core/src/math.ts"], packages, tests);
  assert.deepEqual(result.packages, ["core"]);
  assert.deepEqual(result.unitTests, tests.slice(0, 2));
  assert.deepEqual(result.toolingTests, []);
  assert.deepEqual(result.distributionTests, []);
});

test("test edits select the exact existing test and never select a deleted test", () => {
  const result = selectChecks(
    ["apps/editor/src/panel.test.tsx", "apps/editor/src/deleted.test.tsx"],
    packages,
    tests,
  );
  assert.deepEqual(result.packages, ["editor"]);
  assert.deepEqual(result.unitTests, ["apps/editor/src/panel.test.tsx"]);
});

test("agent guidance and repository prose remain diff-only locally", () => {
  for (const file of [
    "AGENTS.md",
    ".agents/rules/agent-workflow.md",
    ".cursor/rules/agent-workflow.mdc",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "README.md",
    "packages/core/README.md",
    "skills-lock.json",
  ]) {
    const result = selectChecks([file], packages, tests);
    assert.deepEqual(result.packages, [], file);
    assert.deepEqual(result.unitTests, [], file);
    assert.deepEqual(result.toolingTests, [], file);
    assert.deepEqual(result.distributionTests, [], file);
    assert.equal(result.docs, false, file);
  }
});

test("docs changes run a lightweight catalog contract and the docs build", () => {
  const content = selectChecks(
    ["docs/architecture/testing.md"],
    packages,
    tests,
  );
  assert.deepEqual(content.packages, []);
  assert.deepEqual(content.unitTests, ["apps/docs/src/sidebar.test.ts"]);
  assert.equal(content.docs, true);

  const code = selectChecks(["apps/docs/src/sidebar.ts"], packages, tests);
  assert.deepEqual(code.packages, ["docs-site"]);
  assert.deepEqual(code.unitTests, ["apps/docs/src/sidebar.test.ts"]);
  assert.equal(code.docs, true);
});

test("tooling and distribution scripts select only their related contracts", () => {
  const tooling = selectChecks(
    [
      "scripts/browser-server.mjs",
      "scripts/test-selection.mjs",
      "scripts/verify-local.mjs",
    ],
    packages,
    tests,
  );
  assert.deepEqual(tooling.packages, []);
  assert.deepEqual(tooling.toolingTests, [
    "scripts/browser-server.test.mjs",
    "scripts/preflight-selection.test.mjs",
    "scripts/verify-local.test.mjs",
  ]);
  assert.deepEqual(tooling.distributionTests, []);

  const distribution = selectChecks(
    ["scripts/distribution/apple-assets.mjs"],
    packages,
    tests,
  );
  assert.deepEqual(distribution.packages, []);
  assert.deepEqual(distribution.toolingTests, []);
  assert.deepEqual(distribution.distributionTests, [
    "scripts/distribution/apple-assets.test.mjs",
  ]);
});

test("root build configuration and truly unknown paths retain conservative static checks", () => {
  const rootTooling = tests.filter(
    (file) =>
      file.startsWith("scripts/") && !file.startsWith("scripts/distribution/"),
  );
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "vitest.workspace.ts",
    "new-system/source.ts",
  ]) {
    const result = selectChecks([file], packages, tests);
    assert.deepEqual(
      result.packages,
      ["core", "docs-site", "editor", "other", "render"],
      file,
    );
    assert.deepEqual(result.toolingTests, rootTooling, file);
    assert.deepEqual(result.distributionTests, [], file);
    assert.equal(
      result.full,
      undefined,
      "preflight cannot silently expand to the full gate",
    );
  }
});
