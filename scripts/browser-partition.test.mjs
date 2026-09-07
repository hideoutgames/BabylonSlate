import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionTests, reportEntries } from "./browser-partition.mjs";

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
