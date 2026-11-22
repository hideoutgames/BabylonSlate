import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

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

/** A repository with a budget at scripts/bundle-budget.json and two built entries under dist/. */
async function budgetFixture(t, entries) {
  const repo = await mkdtemp(join(tmpdir(), "bundle-budget-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(join(repo, "scripts"));
  await mkdir(join(repo, "dist"));
  // Text that compresses, but not to almost nothing.
  const page = Buffer.from(Array.from({ length: 3000 }, (_, i) => `const v${i} = ${(i * 7919) % 1000};\n`).join(""));
  const worker = Buffer.from(Array.from({ length: 500 }, (_, i) => `self.w${i} = ${(i * 104729) % 977};\n`).join(""));
  await writeFile(join(repo, "dist", "player.js"), page);
  await writeFile(join(repo, "dist", "worker-entry.js"), worker);
  // The budget's measure, computed here with plain zlib: gzip level 9.
  const size = { page: gzipSync(page, { level: 9 }).length, worker: gzipSync(worker, { level: 9 }).length };
  const budget = join(repo, "scripts", "bundle-budget.json");
  await writeFile(budget, JSON.stringify({ root: "dist", entries: entries(size) }));
  return { budget, size };
}

test("the budget passes at or under each ceiling and reports size, ceiling and delta", async (t) => {
  const { budget, size } = await budgetFixture(t, (s) => ({
    "player.js": { gzip: s.page },
    "worker-entry.js": { gzip: s.worker + 50 },
  }));
  const result = report("--budget", budget);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`| \`player.js\` | ${size.page} B | ${size.page} B | 0 B |`), result.stdout);
  assert.ok(result.stdout.includes(`| \`worker-entry.js\` | ${size.worker} B | ${size.worker + 50} B | -50 B |`), result.stdout);
});

test("an entry over its ceiling fails with its size, ceiling, delta and the update rule", async (t) => {
  const { budget, size } = await budgetFixture(t, (s) => ({
    "player.js": { gzip: s.page - 1 },
    "worker-entry.js": { gzip: s.worker },
  }));
  const result = report("--budget", budget);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(`player.js: ${size.page} bytes gzip is over its ceiling of ${size.page - 1} bytes by 1 bytes`),
    result.stderr,
  );
  assert.doesNotMatch(result.stderr, /worker-entry\.js: .* over/);
  assert.match(result.stderr, /raises its ceiling in scripts\/bundle-budget\.json in the same pull request/);
});

test("a missing entry file or a missing ceiling fails instead of passing unchecked", async (t) => {
  const renamed = report(
    "--budget",
    (await budgetFixture(t, (s) => ({ "player.js": { gzip: s.page }, "worker-renamed.js": { gzip: s.worker } }))).budget,
  );
  assert.notEqual(renamed.status, 0);
  assert.match(renamed.stderr, /worker-renamed\.js: not found in dist/);

  const unbudgeted = report(
    "--budget",
    (await budgetFixture(t, (s) => ({ "player.js": { gzip: s.page }, "worker-entry.js": {} }))).budget,
  );
  assert.notEqual(unbudgeted.status, 0);
  assert.match(unbudgeted.stderr, /worker-entry\.js: the budget has no gzip ceiling/);

  const none = report("--budget", (await budgetFixture(t, () => ({}))).budget);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /at least one entry/);
});
