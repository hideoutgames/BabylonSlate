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
