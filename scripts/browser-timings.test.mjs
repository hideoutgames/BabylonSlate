import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTimingReports } from "./browser-timings.mjs";

const script = join(import.meta.dirname, "browser-timings.mjs");

/** A Playwright JSON report: `results` per test as `[status, duration, retry?]`. */
function report(tests) {
  return {
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        specs: [],
        suites: [
          {
            title: "Flow",
            file: "a.spec.ts",
            specs: tests.map(({ title, project = "desktop-chrome", status = "expected", results }) => ({
              title,
              file: "a.spec.ts",
              tests: [
                {
                  projectName: project,
                  status,
                  results: results.map(([s, duration, retry = 0]) => ({ status: s, duration, retry })),
                },
              ],
            })),
          },
        ],
      },
    ],
  };
}

test("weights are the median of passing first attempts across reports, rounded to 0.1 s", () => {
  const tests = mergeTimingReports([
    report([
      { title: "steady", results: [["passed", 12_340]] },
      { title: "even", results: [["passed", 1000]] },
      { title: "flaky", status: "flaky", results: [["failed", 60_000], ["passed", 5000, 1]] },
      { title: "tiny", results: [["passed", 20]] },
      { title: "tagged @ipad", project: "ipad-landscape", results: [["passed", 7000]] },
    ]),
    report([
      { title: "steady", results: [["passed", 50_000]] },
      { title: "even", results: [["passed", 2000]] },
      { title: "flaky", results: [["passed", 4000]] },
    ]),
    report([
      { title: "steady", results: [["passed", 11_000]] },
      { title: "skipped", status: "skipped", results: [["skipped", 0]] },
      { title: "failed", status: "unexpected", results: [["failed", 3000], ["failed", 3000, 1]] },
    ]),
  ]);
  assert.deepEqual(tests, {
    "[desktop-chrome] > a.spec.ts > Flow > even": 1500,
    // Only the run whose first attempt passed supplies a sample.
    "[desktop-chrome] > a.spec.ts > Flow > flaky": 4000,
    "[desktop-chrome] > a.spec.ts > Flow > skipped": 100,
    "[desktop-chrome] > a.spec.ts > Flow > steady": 12_300,
    "[desktop-chrome] > a.spec.ts > Flow > tiny": 100,
    // The partition looks timings up without trailing @ipad tags; a test that never passed has no entry.
    "[ipad-landscape] > a.spec.ts > Flow > tagged": 7000,
  });
});

test("an empty input is refused rather than writing empty timings", () => {
  assert.throws(() => mergeTimingReports([]), /No Playwright reports/);
  assert.throws(() => mergeTimingReports([{ suites: [] }]), /lists no tests/);
});

test("the command writes the timings file the partition reads, recording the source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "browser-timings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "timings.json");
  await writeFile(input, JSON.stringify(report([{ title: "one", results: [["passed", 2000]] }])));
  const output = join(dir, "browser-timings.json");
  const { main } = await import("./browser-timings.mjs");
  await main(["--source", "runs 1 and 2", input], output);
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.source, "runs 1 and 2");
  assert.deepEqual(written.tests, { "[desktop-chrome] > a.spec.ts > Flow > one": 2000 });
  assert.equal(written.updates[0].source, "runs 1 and 2");
  const missing = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--source/);
});
