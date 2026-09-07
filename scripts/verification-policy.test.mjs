import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
