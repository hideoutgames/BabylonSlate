import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { partitionTests, reportEntries } from "./browser-partition.mjs";
import { workerArguments } from "./worker-arguments.mjs";

test("CI partition discovery preserves resolved worker limits without permitting test filters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "browser-partition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const file of ["browser-partition.mjs", "process-runner.mjs"])
    await cp(new URL(file, import.meta.url), join(root, "scripts", file));
  const cli = join(root, "node_modules/@playwright/test");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "package.json"), '{"name":"@playwright/test"}');
  const report = {
    suites: [
      {
        title: "selected.spec.ts",
        specs: [
          {
            title: "executes",
            file: "selected.spec.ts",
            tests: [{ projectName: "desktop" }],
          },
        ],
      },
    ],
  };
  // Replace only Playwright discovery, keeping command launch and manifest I/O real.
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

test("report identities include project and nested titles, with conservative weights for new tests", () => {
  const suites = [
    {
      title: "a.spec.ts",
      file: "a.spec.ts",
      suites: [
        {
          title: "Journey",
          specs: [
            {
              title: "boots",
              file: "a.spec.ts",
              tests: [{ projectName: "desktop" }, { projectName: "tablet" }],
            },
          ],
        },
      ],
    },
  ];
  const entries = reportEntries(
    { suites },
    { "[desktop] > a.spec.ts > Journey > boots": 1200 },
  );
  assert.deepEqual(
    entries.map((e) => [e.key, e.weight]),
    [
      ["[desktop] > a.spec.ts > Journey > boots", 1200],
      ["[tablet] > a.spec.ts > Journey > boots", 30000],
    ],
  );
  assert.notEqual(entries[0].group, entries[1].group);
});
