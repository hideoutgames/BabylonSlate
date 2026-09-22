import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  verificationPolicy,
  requiredVerifyJobs,
} from "./verification-policy.mjs";

test("workflow admission and required-check policy agree on every browser partition", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/verify.yml", import.meta.url),
    "utf8",
  );
  const matrix = /shard:\s*\[([^\]]+)\]/.exec(workflow);
  assert.ok(matrix, "Browser matrix is missing");
  const ids = matrix[1].split(",").map((value) => Number(value.trim()));
  const command = /--partition=\$\{\{\s*matrix.shard\s*\}\}\/(\d+)/.exec(
    workflow,
  );
  assert.ok(command, "Browser command must select the matrix partition");
  assert.equal(+command[1], verificationPolicy.e2eShards);
  assert.deepEqual(
    ids,
    Array.from({ length: verificationPolicy.e2eShards }, (_, i) => i + 1),
  );
  assert.deepEqual(requiredVerifyJobs, [
    "static",
    "unit",
    ...ids.map((id) => `e2e (${id})`),
  ]);
  assert.ok(
    verificationPolicy.readyPrSlots * requiredVerifyJobs.length + 1 <= 20,
    "Leave capacity for post-merge Preview",
  );
});

test("independent browser startup retains all required validation and fails closed", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/verify.yml", import.meta.url),
      "utf8",
    ),
  );
  const { static: staticJob, unit, e2e } = workflow.jobs;
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [
    "e2e",
    "static",
    "unit",
  ]);
  assert.equal(e2e.needs, undefined);
  for (const command of [
    "pnpm test:tooling",
    "pnpm test:distribution",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm --filter docs-site build",
  ])
    assert.ok(
      staticJob.steps.some((step) => step.run === command),
      `Required static command missing: ${command}`,
    );
  assert.ok(unit.steps.some((step) => step.run === "pnpm test:coverage"));
  const browser = e2e.steps.find((step) =>
    step.run?.startsWith("pnpm test:e2e "),
  );
  assert.equal(browser.env.BL_TEST_BUILD_MODE, "ci-bundle");
  assert.equal(browser.if, undefined);
  for (const job of [staticJob, unit, e2e]) {
    assert.notEqual(job["continue-on-error"], true);
    for (const step of job.steps)
      assert.notEqual(step["continue-on-error"], true);
  }
  assert.equal(
    staticJob.steps.some((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ),
    false,
  );
  assert.equal(
    e2e.steps.some((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    ),
    false,
  );
});
