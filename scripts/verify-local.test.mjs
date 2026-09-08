import { test } from "node:test";
import assert from "node:assert/strict";
import { availablePreflightTests, preflightPhases } from "./verify-local.mjs";

test("preflight discovers unit, tooling, distribution, and root policy tests", () => {
  const files = [
    "apps/editor/src/panel.test.tsx",
    "packages/core/src/math.test.ts",
    "scripts/verify-local.test.mjs",
    "scripts/distribution/workflow.test.mjs",
    "playwright.config.test.ts",
    "e2e/editor-smoke.spec.ts",
    "scripts/deleted.test.mjs",
    "README.md",
    "",
  ];
  assert.deepEqual(
    availablePreflightTests(files, new Set(["scripts/deleted.test.mjs"])),
    files.slice(0, 5),
  );
});

test("focused preflight runs selected tooling and distribution contracts", () => {
  const unitTests = Array.from(
    { length: 103 },
    (_, index) => `apps/editor/src/panel-${index}.test.tsx`,
  );
  const phases = preflightPhases(
    {
      toolingTests: ["scripts/verify-local.test.mjs"],
      distributionTests: ["scripts/distribution/workflow.test.mjs"],
      packages: ["core", "editor"],
      unitTests,
      docs: true,
    },
    [
      { name: "core", scripts: { typecheck: "tsc" } },
      { name: "editor", scripts: { typecheck: "tsc" } },
      { name: "unrelated", scripts: { typecheck: "tsc" } },
    ],
    ["scripts/verify-local.mjs"],
  );
  assert.deepEqual(phases.find((phase) => phase.id === "tooling").args, [
    "scripts/verify-local.test.mjs",
  ]);
  assert.deepEqual(phases.find((phase) => phase.id === "distribution").args, [
    "scripts/distribution/workflow.test.mjs",
  ]);
  assert.deepEqual(
    phases.find((phase) => phase.id === "docs"),
    {
      id: "docs",
      runner: "pnpm",
      profile: "docs",
      args: ["--filter", "docs-site", "build"],
    },
  );
  const units = phases.filter((phase) => phase.mode === "unit");
  assert.deepEqual(
    units.flatMap((phase) => phase.args),
    unitTests,
  );
  assert.ok(units.every((phase) => phase.args.length <= 50));
  assert.equal(
    phases.find((phase) => phase.id === "typecheck").profile,
    "typecheck",
  );
  assert.ok(
    !phases.some((phase) =>
      ["coverage", "editor", "e2e", "verify"].includes(phase.mode),
    ),
  );
  assert.ok(
    !phases
      .find((phase) => phase.id === "typecheck")
      .args.includes("unrelated"),
  );
});

test("metadata-only preflight starts no test, typecheck, or docs process", () => {
  const phases = preflightPhases(
    {
      toolingTests: [],
      distributionTests: [],
      packages: [],
      unitTests: [],
      docs: false,
    },
    [],
    [],
  );
  assert.deepEqual(phases, []);
});

test("documentation-only preflight uses the dedicated docs workload", () => {
  const phases = preflightPhases(
    {
      toolingTests: [],
      distributionTests: [],
      packages: [],
      unitTests: [],
      docs: true,
    },
    [],
    [],
  );
  assert.deepEqual(phases, [
    {
      id: "docs",
      runner: "pnpm",
      profile: "docs",
      args: ["--filter", "docs-site", "build"],
    },
  ]);
});
