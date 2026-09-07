import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { join } from "node:path";
import { repoRoot } from "./process-runner.mjs";

test("lint excludes copied browser bundles while retaining authored code", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  assert.equal(
    await eslint.isPathIgnored(
      join(repoRoot, ".cache/test-build/key/assets/bundle.js"),
    ),
    true,
  );
  assert.equal(
    await eslint.isPathIgnored(join(repoRoot, "packages/core/src/index.ts")),
    false,
  );
});
