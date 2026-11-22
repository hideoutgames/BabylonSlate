import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "bundle-report.mjs");

function report(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "bundle-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "assets", "wasm"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<html></html>");
  await writeFile(join(dir, "assets", "index.js"), "a".repeat(4096));
  await writeFile(join(dir, "assets", "wasm", "decoder.wasm"), Buffer.alloc(2048, 7));
  return dir;
}

test("reports every nested file largest first with consistent totals", async (t) => {
  const result = report("--json", await fixture(t));
  assert.equal(result.status, 0, result.stderr);
  const [bundle] = JSON.parse(result.stdout).reports;
  assert.deepEqual(
    bundle.files.map(({ path, raw }) => [path, raw]),
    [
      ["assets/index.js", 4096],
      ["assets/wasm/decoder.wasm", 2048],
      ["index.html", 13],
    ],
  );
  // Repetitive content compresses far below its raw size.
  assert.ok(bundle.files[0].gzip > 0 && bundle.files[0].gzip < 100);
  assert.equal(bundle.total.files, 3);
  assert.equal(bundle.total.raw, 4096 + 2048 + 13);
  assert.equal(
    bundle.total.gzip,
    bundle.files.reduce((sum, file) => sum + file.gzip, 0),
  );
});

test("markdown table lists files and totals for each requested directory", async (t) => {
  const dir = await fixture(t);
  const result = report(dir, dir);
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.split("\n").filter((line) => line.startsWith("| `"));
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.split("|")[1].trim()),
    ["`assets/index.js`", "`assets/wasm/decoder.wasm`", "`index.html`"],
  );
  assert.match(rows[0], /\| 4\.0 KiB \|/);
  assert.equal(result.stdout.match(/\*\*Total \(3 files\)\*\* \| \*\*6\.0 KiB\*\*/g)?.length, 2);
});

test("a missing build directory fails instead of reporting an empty bundle", () => {
  const missing = join(tmpdir(), "bundle-report-missing", "dist");
  const result = report(missing);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Bundle directory not found/);
});

async function budgetFile(t, budgets) {
  const dir = await mkdtemp(join(tmpdir(), "bundle-budgets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "budgets.json");
  await writeFile(path, JSON.stringify({ budgets }));
  return path;
}

test("budgets measure the matching files' gzip total or largest file and pass within their limits", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "assets", "other.js"), "b".repeat(1024));
  await writeFile(join(dir, "root.js"), "c".repeat(8192));
  const budgets = await budgetFile(t, [
    { name: "Assets JS", root: dir, prefix: "assets/", extension: ".js", measure: "total", maxGzipBytes: 1_000_000 },
    { name: "Largest JS", root: dir, extension: ".js", measure: "largest", maxGzipBytes: 1_000_000 },
  ]);
  const result = report("--json", "--budgets", budgets, dir);
  assert.equal(result.status, 0, result.stderr);
  const { reports, budgets: checked } = JSON.parse(result.stdout);
  const gzip = Object.fromEntries(reports[0].files.map((file) => [file.path, file.gzip]));
  // root.js is outside the assets/ prefix, and the wasm file has another extension.
  assert.deepEqual(checked, [
    { name: "Assets JS", gzip: gzip["assets/index.js"] + gzip["assets/other.js"], maxGzipBytes: 1_000_000, exceeded: false },
    {
      name: "Largest JS",
      gzip: Math.max(gzip["assets/index.js"], gzip["assets/other.js"], gzip["root.js"]),
      maxGzipBytes: 1_000_000,
      exceeded: false,
    },
  ]);
  const markdown = report("--budgets", budgets, dir);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /\| Assets JS \| .+ \| 976\.6 KiB \| Within budget \|/);
});

test("a bundle over its budget still prints the whole report and fails", async (t) => {
  const dir = await fixture(t);
  const budgets = await budgetFile(t, [{ name: "Wasm", root: dir, extension: ".wasm", measure: "total", maxGzipBytes: 1 }]);
  const result = report("--budgets", budgets, dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\| Wasm \| .+ \| 1 B \| \*\*Over budget\*\* \|/);
  assert.match(result.stdout, /\*\*Total \(3 files\)\*\*/);
  assert.match(result.stderr, /exceeds its size budget/);
});

test("a budget for an unmeasured directory, matching no file, or malformed fails instead of passing", async (t) => {
  const dir = await fixture(t);
  const cases = [
    [[{ name: "Elsewhere", root: join(dir, "missing"), extension: ".js", measure: "total", maxGzipBytes: 10 }], /was not measured/],
    [[{ name: "CSS", root: dir, extension: ".css", measure: "total", maxGzipBytes: 10 }], /matches no file/],
    [[{ name: "Unknown measure", root: dir, extension: ".js", measure: "average", maxGzipBytes: 10 }], /Invalid budget/],
    [[], /No budgets/],
  ];
  for (const [budgets, message] of cases) {
    const result = report("--budgets", await budgetFile(t, budgets), dir);
    assert.equal(result.status, 1, JSON.stringify(budgets));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
  assert.match(report(dir, "--budgets").stderr, /needs a budget file/);
});

test("the committed Pages and test-build budgets are well formed and name the directories their workflows measure", async () => {
  const { readBudgets } = await import("./bundle-report.mjs");
  for (const file of ["bundle-budgets.json", "bundle-budgets-test-build.json"]) {
    const budgets = readBudgets(join(import.meta.dirname, file));
    assert.deepEqual([...new Set(budgets.map((budget) => budget.root))].sort(), ["apps/editor/dist", "apps/player/dist"], file);
  }
});
