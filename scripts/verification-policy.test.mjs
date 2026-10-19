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
});

const mergeCommand = [
  'git fetch --no-tags --quiet origin "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF"',
  'git show "refs/remotes/origin/$BASE_REF:scripts/merge-pr-base.mjs" > "$RUNNER_TEMP/merge-pr-base.mjs" || cp scripts/merge-pr-base.mjs "$RUNNER_TEMP/merge-pr-base.mjs"',
  'node "$RUNNER_TEMP/merge-pr-base.mjs"',
  "",
].join("\n");

test("every pull-request job tests the head merged with the base branch as it is when the job runs", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/verify.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(Object.keys(workflow.jobs).length > 0);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const checkouts = job.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkouts.length, 1, `${name} checks out once`);
    const [checkout, merge] = job.steps;
    assert.equal(checkout, checkouts[0], `${name} starts with the checkout`);
    // The head commit, never refs/pull/N/merge, which GitHub recomputes lazily;
    // a push to main still gets the pushed commit.
    assert.equal(
      checkout.with.ref,
      "${{ github.event.pull_request.head.sha || github.sha }}",
      name,
    );
    // The merge needs the history that joins the head to the base.
    assert.equal(checkout.with["fetch-depth"], 0, name);
    // The base branch's copy, so heads cut before the script existed still merge.
    assert.equal(merge.run, mergeCommand, name);
    assert.equal(merge.if, "github.event_name == 'pull_request'", name);
    assert.deepEqual(
      merge.env,
      {
        BASE_REF: "${{ github.base_ref }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      },
      name,
    );
  }
});
