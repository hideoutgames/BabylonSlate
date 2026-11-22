import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import fc from "fast-check";
import {
  parseTestListLine,
  partitionTests,
  reportEntries,
  reportTests,
  specSources,
  wholeFileReason,
} from "./browser-partition.mjs";
import { repoRoot, toolCli } from "./process-runner.mjs";
import { verificationPolicy } from "./verification-policy.mjs";
import { workerArguments } from "./worker-arguments.mjs";

/** A listing as `playwright test --list --reporter=json` prints it: one spec per title path, one test per project. */
function listing(specs, rootDir = "/specs") {
  const files = new Map();
  for (const { file, path, projects = ["desktop"] } of specs) {
    const root = files.get(file) ?? { title: file, file, specs: [], suites: [] };
    files.set(file, root);
    let suite = root;
    for (const title of path.slice(0, -1)) {
      let child = suite.suites.find((s) => s.title === title);
      if (!child) suite.suites.push((child = { title, file, specs: [], suites: [] }));
      suite = child;
    }
    suite.specs.push({
      title: path.at(-1),
      file,
      tests: projects.map((projectName) => ({ projectName })),
    });
  }
  return { config: { rootDir }, suites: [...files.values()] };
}

/** The tests Playwright 1.62 runs for a `--test-list` file (its `loadTestList` filter), over the whole listing. */
function playwrightSelection(lines, tests) {
  const descriptions = lines.map(parseTestListLine);
  return tests
    .filter((test) =>
      descriptions.some(
        (d) =>
          (d.project === undefined || d.project === test.project) &&
          d.file === test.file &&
          d.titlePath.length <= test.titles.length &&
          d.titlePath.every((title, i) => test.titles[i] === title),
      ),
    )
    .map((test) => test.key);
}

test("CI partition discovery preserves resolved worker limits without permitting test filters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "browser-partition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "e2e"));
  for (const file of ["browser-partition.mjs", "process-runner.mjs"])
    await cp(new URL(file, import.meta.url), join(root, "scripts", file));
  const cli = join(root, "node_modules/@playwright/test");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "package.json"), '{"name":"@playwright/test"}');
  await writeFile(join(root, "e2e/selected.spec.ts"), 'test("executes", () => {});\n');
  const report = listing(
    [{ file: "selected.spec.ts", path: ["executes"] }],
    join(root, "e2e"),
  );
  // Replace only Playwright discovery, keeping command launch, spec reads and manifest I/O real.
  await writeFile(
    join(cli, "cli.js"),
    `console.log(${JSON.stringify(JSON.stringify(report))});`,
  );
  await writeFile(join(root, "scripts/browser-timings.json"), '{"tests":{}}');
  const { browserPartitionArgs } = await import(
    pathToFileURL(join(root, "scripts/browser-partition.mjs"))
  );
  const args = workerArguments(
    ["--partition=1/1"],
    { browserWorkers: 1, retries: 2 },
    "browser",
  );
  const selected = await browserPartitionArgs(args);
  assert.equal(selected[0], "--test-list");
  assert.equal(
    await readFile(selected[1], "utf8"),
    "[desktop] > selected.spec.ts > executes\n",
  );
  assert.deepEqual(selected.slice(2), ["--workers=1", "--retries=2"]);
  for (const filter of [
    "other.spec.ts",
    "--grep=other",
    "--project=tablet",
    "--partition=1/2",
  ])
    await assert.rejects(
      browserPartitionArgs([...args, filter]),
      /cannot be combined with filters/,
    );
});

test("partitions preserve every device execution exactly once and keep groups together", () => {
  const entries = [
    { key: "desktop-a", group: "desktop-serial", weight: 40 },
    { key: "desktop-b", group: "desktop-serial", weight: 30 },
    { key: "tablet-a", group: "tablet-serial", weight: 40 },
    { key: "tablet-b", group: "tablet-serial", weight: 30 },
    { key: "desktop-c", group: "desktop-c", weight: 60 },
    { key: "desktop-d", group: "desktop-d", weight: 10 },
  ];
  const parts = partitionTests(entries, 3);
  assert.deepEqual(
    parts.map((p) => p.weight),
    [70, 70, 70],
  );
  assert.deepEqual(
    parts.flatMap((p) => p.entries.map((e) => e.key)).sort(),
    entries.map((e) => e.key).sort(),
  );
  assert.equal(
    parts.filter((p) => p.entries.some((e) => e.group === "desktop-serial"))
      .length,
    1,
  );
  assert.deepEqual(partitionTests([...entries].reverse(), 3), parts);
  assert.throws(
    () => partitionTests([...entries, entries[0]], 3),
    /duplicate/i,
  );
  assert.throws(() => partitionTests(entries, 0), /partition/i);
});

test("report identities include project and nested titles", () => {
  const entries = reportEntries(
    listing([
      { file: "a.spec.ts", path: ["Journey", "boots"], projects: ["desktop", "tablet"] },
    ]),
    { "[desktop] > a.spec.ts > Journey > boots": 1200 },
  );
  assert.deepEqual(
    entries.map((e) => e.key),
    [
      "[desktop] > a.spec.ts > Journey > boots",
      "[tablet] > a.spec.ts > Journey > boots",
    ],
  );
  assert.notEqual(entries[0].group, entries[1].group);
});

test("an unrecorded test weighs the median of its file and project, then its file, then the listing", () => {
  const report = listing([
    { file: "a.spec.ts", path: ["one"], projects: ["desktop", "tablet"] },
    { file: "a.spec.ts", path: ["two"], projects: ["desktop", "tablet"] },
    { file: "a.spec.ts", path: ["three"] },
    { file: "a.spec.ts", path: ["new"], projects: ["desktop", "tablet"] },
    { file: "b.spec.ts", path: ["new"] },
    { file: "c.spec.ts", path: ["tagged @ipad"] },
  ]);
  const weights = (timings) =>
    Object.fromEntries(
      reportEntries(report, timings).map((e) => [e.key, e.weight]),
    );
  const recorded = {
    "[desktop] > a.spec.ts > one": 1000,
    "[desktop] > a.spec.ts > two": 4000,
    "[desktop] > a.spec.ts > three": 9000,
    "[tablet] > a.spec.ts > one": 20_000,
    "[desktop] > c.spec.ts > tagged": 500,
  };
  assert.deepEqual(weights(recorded), {
    "[desktop] > a.spec.ts > one": 1000,
    "[desktop] > a.spec.ts > two": 4000,
    "[desktop] > a.spec.ts > three": 9000,
    // Same file and project: median of 1000, 4000, 9000.
    "[desktop] > a.spec.ts > new": 4000,
    "[tablet] > a.spec.ts > one": 20_000,
    // Same file and project: the one tablet sample.
    "[tablet] > a.spec.ts > two": 20_000,
    "[tablet] > a.spec.ts > new": 20_000,
    // No sample in the file: median of every recorded test in the listing (500, 1000, 4000, 9000, 20000).
    "[desktop] > b.spec.ts > new": 4000,
    // A trailing @ipad title tag is not part of the recorded key.
    "[desktop] > c.spec.ts > tagged @ipad": 500,
  });
  const noTablet = { ...recorded };
  delete noTablet["[tablet] > a.spec.ts > one"];
  // No tablet sample: the file's samples in any project (1000, 4000, 9000).
  assert.equal(weights(noTablet)["[tablet] > a.spec.ts > new"], 4000);
  // An even count takes the mean of the middle two.
  assert.equal(
    weights({ "[desktop] > a.spec.ts > one": 1000, "[desktop] > a.spec.ts > two": 4000 })[
      "[desktop] > a.spec.ts > new"
    ],
    2500,
  );
  // Nothing recorded at all.
  assert.ok(Object.values(weights({})).every((weight) => weight === 30_000));
});

test("tests of an independent file may land in different shards, a whole file's never split", () => {
  const report = listing([
    { file: "parallel.spec.ts", path: ["a"] },
    { file: "parallel.spec.ts", path: ["b"] },
    { file: "parallel.spec.ts", path: ["c"] },
    { file: "serial.spec.ts", path: ["first"], projects: ["desktop", "tablet"] },
    { file: "serial.spec.ts", path: ["second"], projects: ["desktop", "tablet"] },
  ]);
  const timings = {
    "[desktop] > parallel.spec.ts > a": 10_000,
    "[desktop] > parallel.spec.ts > b": 10_000,
    "[desktop] > parallel.spec.ts > c": 10_000,
    "[desktop] > serial.spec.ts > first": 5000,
    "[desktop] > serial.spec.ts > second": 5000,
    "[tablet] > serial.spec.ts > first": 5000,
    "[tablet] > serial.spec.ts > second": 5000,
  };
  const entries = reportEntries(report, timings, (file) => file === "serial.spec.ts");
  const parts = partitionTests(entries, 3).map((p) => p.entries.map((e) => e.key));
  assert.deepEqual(parts, [
    [
      "[desktop] > parallel.spec.ts > a",
      "[desktop] > serial.spec.ts > first",
      "[desktop] > serial.spec.ts > second",
    ],
    [
      "[desktop] > parallel.spec.ts > b",
      "[tablet] > serial.spec.ts > first",
      "[tablet] > serial.spec.ts > second",
    ],
    ["[desktop] > parallel.spec.ts > c"],
  ]);
  // Without the whole-file rule the file would be one 30 s lump.
  const lumped = partitionTests(reportEntries(report, timings), 3);
  assert.equal(
    lumped.filter((p) => p.entries.some((e) => e.key.includes("parallel.spec.ts"))).length,
    1,
  );
});

test("a test-list line that would also select another test keeps both in one shard", () => {
  // Playwright selects by title prefix: the line for top-level "Setup" also selects "Setup > child".
  const report = listing([
    { file: "a.spec.ts", path: ["Setup"] },
    { file: "a.spec.ts", path: ["Setup", "child"] },
    { file: "a.spec.ts", path: ["other"] },
  ]);
  const entries = reportEntries(report, {}, () => false);
  const group = Object.fromEntries(entries.map((e) => [e.key, e.group]));
  assert.equal(group["[desktop] > a.spec.ts > Setup"], group["[desktop] > a.spec.ts > Setup > child"]);
  assert.notEqual(group["[desktop] > a.spec.ts > Setup"], group["[desktop] > a.spec.ts > other"]);
});

test("a title Playwright cannot select from a test list fails discovery instead of silently dropping the test", () => {
  for (const title of ["a > b", "a › b", " padded"])
    assert.throws(
      () => reportEntries(listing([{ file: "a.spec.ts", path: [title] }]), {}, () => false),
      /cannot select this test/,
    );
});

test("files that order tests or share state between them stay whole", () => {
  assert.equal(wholeFileReason('test.describe.configure({ mode: "serial" });'), "describe.configure");
  assert.equal(wholeFileReason('test.describe.serial("flow", () => {});'), "serial suite");
  assert.equal(wholeFileReason('test.describe.configure({ mode: "default" });'), "describe.configure");
  assert.equal(wholeFileReason("test.beforeAll(async () => {});"), "file-level hook");
  assert.equal(wholeFileReason("test.afterAll(async () => {});"), "file-level hook");
  assert.equal(wholeFileReason("import x from 'y';\nlet project: string;\n"), "module-level mutable state");
  assert.equal(
    wholeFileReason(
      'test.use({ hasTouch: true });\ntest.beforeEach(async () => {});\nconst LIMIT = 3;\ntest("a", async () => {\n  let local = 0;\n});\n',
    ),
    null,
  );
});

test("generated listings: shards together select every test exactly once and whole files stay in one shard", () => {
  const title = fc.constantFrom("a", "b", "c", "Setup", "Journey");
  const spec = fc.record({
    file: fc.constantFrom("f1.spec.ts", "f2.spec.ts", "f3.spec.ts", "f4.spec.ts"),
    path: fc.array(title, { minLength: 1, maxLength: 3 }),
    projects: fc.subarray(["desktop", "tablet"], { minLength: 1 }),
  });
  fc.assert(
    fc.property(
      fc.uniqueArray(spec, {
        minLength: 1,
        maxLength: 30,
        selector: (s) => `${s.file}|${s.path.join(">")}`,
      }),
      fc.subarray(["f1.spec.ts", "f2.spec.ts", "f3.spec.ts", "f4.spec.ts"]),
      fc.dictionary(fc.constantFrom("a", "b", "c", "Setup"), fc.integer({ min: 100, max: 100_000 })),
      fc.integer({ min: 1, max: 6 }),
      (specs, whole, weights, count) => {
        const report = listing(specs);
        const tests = reportTests(report);
        const timings = Object.fromEntries(
          tests.map((t) => [t.key, weights[t.titles.at(-1)]]).filter(([, w]) => w),
        );
        const parts = partitionTests(
          reportEntries(report, timings, (file) => whole.includes(file)),
          count,
        );
        const selected = parts.map((p) =>
          playwrightSelection(p.entries.map((e) => e.key), tests),
        );
        const all = selected.flat();
        assert.equal(new Set(all).size, all.length, "no test runs in two shards");
        assert.deepEqual([...all].sort(), tests.map((t) => t.key).sort());
        for (const file of whole)
          for (const project of ["desktop", "tablet"])
            assert.ok(
              selected.filter((keys) => keys.some((k) => k.startsWith(`[${project}] > ${file} > `))).length <= 1,
            );
      },
    ),
    { numRuns: 300 },
  );
});

const execFileAsync = promisify(execFile);
async function playwrightList(extra = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [toolCli("@playwright/test"), "test", "--list", "--reporter=json", ...extra],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test("the real browser suite's shards, as Playwright selects them, run every listed test exactly once", async (t) => {
  const report = await playwrightList();
  const tests = reportTests(report);
  assert.ok(tests.length > 0);
  const sources = await specSources(report);
  const timings = JSON.parse(
    await readFile(join(repoRoot, "scripts/browser-timings.json"), "utf8"),
  ).tests;
  const parts = partitionTests(
    reportEntries(report, timings, (file) => wholeFileReason(sources.get(file))),
    verificationPolicy.e2eShards,
  );
  const directory = await mkdtemp(join(tmpdir(), "browser-partition-real-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Playwright's own --test-list filter, not a model of it.
  const selected = await Promise.all(
    parts.map(async (part, index) => {
      const file = join(directory, `${index + 1}.txt`);
      await writeFile(file, part.entries.map((e) => e.key).join("\n") + "\n");
      return reportTests(await playwrightList(["--test-list", file])).map((test) => test.key);
    }),
  );
  const all = selected.flat();
  assert.equal(new Set(all).size, all.length, "no test runs in two shards");
  assert.deepEqual([...all].sort(), tests.map((test) => test.key).sort());
  for (const [file, source] of sources) {
    if (!wholeFileReason(source)) continue;
    for (const project of new Set(tests.map((test) => test.project)))
      assert.ok(
        selected.filter((keys) => keys.some((key) => key.startsWith(`[${project}] > ${file} > `))).length <= 1,
        `${file} runs in one shard`,
      );
  }
});
