import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightPhases } from "./verify-local.mjs";

test("infrastructure preflight stays bounded and leaves exhaustive tests to CI", () => {
  const files = Array.from(
    { length: 103 },
    (_, index) => `apps/editor/src/panel-${index}.test.tsx`,
  );
  const phases = preflightPhases(
    {
      tooling: true,
      packages: ["core", "editor"],
      unitTests: files,
      docs: true,
    },
    [
      { name: "core", scripts: { typecheck: "tsc" } },
      { name: "editor", scripts: { typecheck: "tsc" } },
      { name: "unrelated", scripts: { typecheck: "tsc" } },
    ],
    ["scripts/test-runner.mjs"],
  );
  const units = phases.filter((phase) => phase.mode === "unit");
  assert.deepEqual(
    units.flatMap((phase) => phase.args),
    files,
  );
  assert.ok(units.every((phase) => phase.args.length <= 50));
  assert.ok(phases.some((phase) => phase.mode === "tooling"));
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

test("documentation-only preflight does not start unit or browser processes", () => {
  const phases = preflightPhases(
    { tooling: false, packages: [], unitTests: [], docs: true },
    [],
    [],
  );
  assert.deepEqual(
    phases.map((phase) => phase.id),
    ["docs"],
  );
});
