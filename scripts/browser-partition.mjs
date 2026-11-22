import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot, runCommand, toolCli } from "./process-runner.mjs";

/** Weight of a test when nothing about it or the rest of the listing is known. */
const UNKNOWN_WEIGHT_MS = 30_000;

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

/**
 * Why a spec file's tests must run in one shard, or null when each test may run in any shard. The config runs files
 * fully parallel, so Playwright already treats the tests of any other file as independent; these constructs order
 * tests or share state between them: serial or default-mode suites (`describe.serial`, any `describe.configure`),
 * file-level hooks (`beforeAll` / `afterAll` run once per worker in each shard), module-level `let` / `var`, and an
 * explicit `// browser-partition: keep-whole` comment. A match in a comment or string only keeps a file whole, which
 * is always safe.
 */
export function wholeFileReason(source) {
  // A spec whose tests share state some other way (a helper module's cache one test fills and another reads) says so.
  if (/\bbrowser-partition:\s*keep-whole\b/.test(source)) return "keep-whole marker";
  if (/\bdescribe\s*\.\s*serial\b/.test(source)) return "serial suite";
  if (/\.\s*configure\s*\(/.test(source)) return "describe.configure";
  if (/\b(?:beforeAll|afterAll)\s*\(/.test(source)) return "file-level hook";
  if (/^(?:export\s+)?(?:let|var)\b/m.test(source))
    return "module-level mutable state";
  return null;
}

/** A `--test-list` line as Playwright 1.62 parses it (`loadTestList`). */
export function parseTestListLine(line) {
  const delimiter = line.includes("›") ? "›" : ">";
  const tokens = line
    .trim()
    .split(delimiter)
    .map((token) => token.trim());
  let project;
  if (tokens[0].startsWith("[")) {
    if (!tokens[0].endsWith("]"))
      throw new Error(`Malformed test description: ${line}`);
    project = tokens.shift().slice(1, -1);
  }
  const file = /^(.*?):(\d+):?(\d+)?$/.exec(tokens[0])?.[1] ?? tokens[0];
  return { project, file, titlePath: tokens.slice(1) };
}

/** Playwright selects every test whose titles start with the line's title path, in the same project and file. */
function selects(description, test) {
  return (
    (description.project === undefined ||
      description.project === test.project) &&
    description.file === test.file &&
    description.titlePath.length <= test.titles.length &&
    description.titlePath.every((title, i) => test.titles[i] === title)
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The `browser-timings.json` key of a test: its identity without trailing `@ipad` title tags. */
export function timingKey(key) {
  return key.replace(/(?: @ipad)+$/, "");
}

/** Every listed test execution: one per test and browser project. */
export function reportTests(report) {
  const tests = [];
  function visit(suite, titles = []) {
    const next = suite.title ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replaceAll("\\", "/");
      for (const test of spec.tests ?? []) {
        const path = [...next.slice(1), spec.title];
        tests.push({
          key: `[${test.projectName}] > ${file} > ${path.join(" > ")}`,
          project: test.projectName,
          file,
          titles: path,
          status: test.status,
          results: test.results ?? [],
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, next);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return tests;
}

/**
 * Scheduling entries for a listing. A recorded test weighs its recorded time. A test without one weighs the median of
 * the recorded tests of the same file and project, else of the same file in any project, else of every recorded test
 * in the listing, else 30 s. Tests of a file `keepWhole(file)` names, and tests one `--test-list` line would also
 * select, share a group; every other test is its own group.
 */
export function reportEntries(report, timings = {}, keepWhole = () => true) {
  const tests = reportTests(report);
  const known = (test) => timings[timingKey(test.key)];
  const recorded = (filter) =>
    tests.filter((test) => filter(test) && known(test) !== undefined).map(known);
  const estimate = (test) => {
    for (const filter of [
      (other) => other.file === test.file && other.project === test.project,
      (other) => other.file === test.file,
      () => true,
    ]) {
      const weights = recorded(filter);
      if (weights.length) return median(weights);
    }
    return UNKNOWN_WEIGHT_MS;
  };

  const wholeFiles = new Map();
  const whole = (file) => {
    if (!wholeFiles.has(file)) wholeFiles.set(file, Boolean(keepWhole(file)));
    return wholeFiles.get(file);
  };
  const parent = new Map(tests.map((test) => [test.key, test.key]));
  const root = (key) => {
    while (parent.get(key) !== key) key = parent.get(key);
    return key;
  };
  const merge = (a, b) => {
    const [x, y] = [root(a), root(b)].sort();
    parent.set(y, x);
  };
  const byFile = new Map();
  for (const test of tests) {
    const id = `[${test.project}] > ${test.file}`;
    byFile.set(id, [...(byFile.get(id) ?? []), test]);
  }
  for (const siblings of byFile.values()) {
    if (whole(siblings[0].file))
      for (const test of siblings) merge(siblings[0].key, test.key);
    for (const test of siblings) {
      let description;
      try {
        description = parseTestListLine(test.key);
      } catch {
        description = null;
      }
      if (!description || !selects(description, test))
        throw new Error(
          `Playwright cannot select this test from a test list: ${test.key}. Keep ">", "›" and surrounding spaces out of test titles.`,
        );
      for (const other of siblings)
        if (other !== test && selects(description, other))
          merge(test.key, other.key);
    }
  }
  return tests.map((test) => ({
    key: test.key,
    group: root(test.key),
    weight: known(test) ?? estimate(test),
  }));
}

export async function browserPartitionArgs(args, options = {}) {
  const flag = args.find((arg) => arg.startsWith("--partition="));
  if (!flag) return args;
  const match = /^--partition=(\d+)\/(\d+)$/.exec(flag);
  if (!match || +match[1] < 1 || +match[1] > +match[2])
    throw new Error("Invalid browser partition");
  // The wrapper has already resolved these execution limits. They do not
  // select tests, and must survive replacement of the partition selector.
  const executionArgs = args.filter((arg) =>
    /^--(?:workers|retries)=\d+$/.test(arg),
  );
  if (args.length !== executionArgs.length + 1)
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
  const report = JSON.parse(listed.output);
  const sources = await specSources(report);
  const entries = reportEntries(report, timings.tests, (file) =>
    wholeFileReason(sources.get(file)),
  );
  if (!entries.length) throw new Error("Browser discovery selected no tests");
  const partitions = partitionTests(entries, +match[2]);
  const selected = partitions[+match[1] - 1];
  if (!selected.entries.length) throw new Error("Empty browser partition");
  const directory = join(repoRoot, ".cache/browser-partitions");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${match[1]}-${match[2]}.txt`);
  // Playwright filters by the list and runs the selection in its own order (project, file, declaration).
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
  return ["--test-list", file, ...executionArgs];
}

/** Each listed spec file's source, read from the directory the listing's paths are relative to. */
export async function specSources(report) {
  const rootDir = report.config?.rootDir;
  if (!rootDir) throw new Error("Browser discovery reported no root directory");
  const files = [...new Set(reportTests(report).map((test) => test.file))];
  return new Map(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(join(rootDir, file), "utf8"),
      ]),
    ),
  );
}
