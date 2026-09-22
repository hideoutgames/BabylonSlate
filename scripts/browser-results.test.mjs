import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBrowserResults } from "./browser-results.mjs";

test("browser success requires a fresh report with actual execution and keeps retries/skips visible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-results-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "timings.json");
  await assert.rejects(readBrowserResults(path, "this-run"), /ENOENT/);
  const report = {
    config: { metadata: { testRunNonce: "this-run" } },
    stats: { expected: 4, unexpected: 0, flaky: 1, skipped: 2 },
    errors: [],
  };
  await writeFile(path, JSON.stringify(report));
  assert.deepEqual(await readBrowserResults(path, "this-run"), report.stats);
  await assert.rejects(readBrowserResults(path, "another-run"), /stale/);
  for (const [changed, reason] of [
    [
      { ...report, stats: { ...report.stats, expected: 0, flaky: 0 } },
      /no executed/,
    ],
    [{ ...report, stats: { ...report.stats, unexpected: 1 } }, /failed tests/],
    [
      { ...report, stats: { ...report.stats, expected: null } },
      /invalid outcome/,
    ],
    [
      { ...report, errors: [{ message: "worker interrupted" }] },
      /runner errors/,
    ],
  ]) {
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(readBrowserResults(path, "this-run"), reason);
  }
});
