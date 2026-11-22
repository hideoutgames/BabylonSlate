#!/usr/bin/env node
// Rebuilds scripts/browser-timings.json from Playwright JSON reports. Placement weights only: the timings never select,
// skip or change a test. No network access: download the reports first (see .agents/reference/testing.md).
//
// Usage:
//   node scripts/browser-timings.mjs --source <text> <report.json> [<report.json> ...]
//
// Each report is a shard's `test-results/timings.json` (the `browser-results-<shard>` artifact of a Verify run).
// Pass every shard of one or more green `main` runs.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reportTests, timingKey } from "./browser-partition.mjs";

/** Weight of a test that skips in Verify: it still costs a worker start-up slot, but no test time. */
const SKIPPED_WEIGHT_MS = 100;

export const TIMINGS_SCOPE =
  "Every weight is the median of the successful first-attempt durations in the given reports, rounded to 0.1 s. Failed and retried attempts supply no samples; tests that only skipped carry a nominal 0.1-second weight; tests absent from every report are dropped.";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `{ key: weightMs }` for every test in `reports`, keys sorted. */
export function mergeTimingReports(reports) {
  if (!reports.length) throw new Error("No Playwright reports given");
  const samples = new Map();
  const skipped = new Set();
  for (const report of reports) {
    const tests = reportTests(report);
    if (!tests.length) throw new Error("A Playwright report lists no tests");
    for (const test of tests) {
      const key = timingKey(test.key);
      const first = test.results.find((result) => result.retry === 0);
      if (first?.status === "passed" && Number.isFinite(first.duration))
        samples.set(key, [...(samples.get(key) ?? []), first.duration]);
      else if (test.status === "skipped") skipped.add(key);
    }
  }
  const tests = {};
  for (const key of [...new Set([...samples.keys(), ...skipped])].sort()) {
    tests[key] = samples.has(key)
      ? Math.max(100, Math.round(median(samples.get(key)) / 100) * 100)
      : SKIPPED_WEIGHT_MS;
  }
  return tests;
}

const DEFAULT_OUTPUT = join(import.meta.dirname, "browser-timings.json");

/** Report paths resolve against the working directory. */
export async function main(argv, output = DEFAULT_OUTPUT) {
  const sourceIndex = argv.indexOf("--source");
  const source = sourceIndex >= 0 ? argv[sourceIndex + 1] : undefined;
  if (!source || source.startsWith("-"))
    throw new Error("--source <text> names the runs the reports come from");
  const files = argv.filter(
    (arg, index) => index !== sourceIndex && index !== sourceIndex + 1,
  );
  const unknown = files.filter((arg) => arg.startsWith("-"));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  const reports = await Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(resolve(file), "utf8")),
    ),
  );
  const tests = mergeTimingReports(reports);
  await writeFile(
    output,
    `${JSON.stringify({ source, tests, updates: [{ source, scope: TIMINGS_SCOPE }] }, null, 2)}\n`,
  );
  return `${Object.keys(tests).length} test timings from ${reports.length} reports written to ${output}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
