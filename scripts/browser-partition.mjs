import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot, runCommand, toolCli } from "./process-runner.mjs";

export function partitionTests(entries, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("Invalid partition count");
  const keys = new Set();
  const groups = new Map();
  for (const entry of entries) {
    if (keys.has(entry.key))
      throw new Error(`Duplicate test identity: ${entry.key}`);
    keys.add(entry.key);
    if (!Number.isFinite(entry.weight) || entry.weight <= 0)
      throw new Error(`Invalid weight: ${entry.key}`);
    const group = groups.get(entry.group) ?? {
      key: entry.group,
      entries: [],
      weight: 0,
    };
    group.entries.push(entry);
    group.weight += entry.weight;
    groups.set(entry.group, group);
  }
  const partitions = Array.from({ length: count }, () => ({
    weight: 0,
    entries: [],
  }));
  for (const group of [...groups.values()].sort(
    (a, b) => b.weight - a.weight || a.key.localeCompare(b.key),
  )) {
    const target = partitions.reduce((a, b) => (a.weight <= b.weight ? a : b));
    target.weight += group.weight;
    target.entries.push(
      ...group.entries.sort((a, b) => a.key.localeCompare(b.key)),
    );
  }
  return partitions;
}

export function reportEntries(report, timings = {}) {
  const entries = [];
  function visit(suite, titles = []) {
    const next = suite.title ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replaceAll("\\", "/");
      for (const test of spec.tests ?? []) {
        const key = `[${test.projectName}] > ${file} > ${[...next.slice(1), spec.title].join(" > ")}`;
        entries.push({
          key,
          group: `[${test.projectName}] > ${file}`,
          weight: timings[key.replace(/(?: @ipad)+$/, "")] ?? 30_000,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, next);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return entries;
}

export async function browserPartitionArgs(args, options = {}) {
  const flag = args.find((arg) => arg.startsWith("--partition="));
  if (!flag) return args;
  const match = /^--partition=(\d+)\/(\d+)$/.exec(flag);
  if (!match || +match[1] < 1 || +match[1] > +match[2])
    throw new Error("Invalid browser partition");
  if (args.length !== 1)
    throw new Error("CI partitions cannot be combined with filters");
  const listed = await runCommand(
    process.execPath,
    [toolCli("@playwright/test"), "test", "--list", "--reporter=json"],
    { ...options, capture: true },
  );
  if (listed.code) throw new Error(listed.output);
  const timings = JSON.parse(
    await readFile(join(repoRoot, "scripts/browser-timings.json"), "utf8"),
  );
  const entries = reportEntries(JSON.parse(listed.output), timings.tests);
  if (!entries.length) throw new Error("Browser discovery selected no tests");
  // File + browser project is a conservative scheduling group: serial suites can never be split.
  const partitions = partitionTests(entries, +match[2]);
  const selected = partitions[+match[1] - 1];
  if (!selected.entries.length) throw new Error("Empty browser partition");
  const directory = join(repoRoot, ".cache/browser-partitions");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${match[1]}-${match[2]}.txt`);
  await writeFile(
    file,
    selected.entries.map((entry) => entry.key).join("\n") + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      event: "partition",
      index: +match[1],
      count: +match[2],
      tests: selected.entries.length,
      estimatedMs: selected.weight,
    }) + "\n",
  );
  return ["--test-list", file];
}
