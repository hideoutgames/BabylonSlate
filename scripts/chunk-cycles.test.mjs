import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChunkCycles } from "./chunk-cycles.mjs";

const script = join(import.meta.dirname, "chunk-cycles.mjs");

/** Writes minified-style chunks under `assets/` and returns the build directory. */
async function build(t, chunks) {
  const dir = await mkdtemp(join(tmpdir(), "chunk-cycles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "assets"), { recursive: true });
  for (const [name, text] of Object.entries(chunks)) await writeFile(join(dir, "assets", name), text);
  return dir;
}

const faultsOf = (dir) =>
  findChunkCycles([dir]).faults.map(({ chunk, name, imported, from, kind }) => [chunk, kind, name, imported, from]);

// The production fault in miniature: the render chunk re-exports from an editor chunk whose top-level class extends
// a base the render chunk owns.
const renderChunk = 'import{t as e}from"./editor-a.js";var n=class{};export{n as a,e as b};';

test("a top-level class extends across a chunk cycle fails the check and names the binding", async (t) => {
  const dir = await build(t, {
    "render-a.js": renderChunk,
    "editor-a.js": 'import{a as Vn}from"./render-a.js";var Ms=class extends Vn{};export{Ms as t};',
  });
  assert.deepEqual(faultsOf(dir), [["assets/editor-a.js", "extends", "Vn", "a", "assets/render-a.js"]]);
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Chunk cycle in .*: assets\/editor-a\.js <-> assets\/render-a\.js/);
  assert.match(result.stdout, /assets\/editor-a\.js:1:\d+ extends `Vn` \(export `a` of assets\/render-a\.js/);
});

test("other top-level reads across a cycle fail, including computed keys and static initialisers", async (t) => {
  const dir = await build(t, {
    "render-a.js": renderChunk,
    "editor-a.js":
      'import{a as k,c as v,d as s}from"./render-a.js";var o={[k]:1},l=v.map(e=>e),C=class{static x=s};export{o as t};',
  });
  assert.deepEqual(faultsOf(dir), [
    ["assets/editor-a.js", "read", "k", "a", "assets/render-a.js"],
    ["assets/editor-a.js", "read", "v", "c", "assets/render-a.js"],
    ["assets/editor-a.js", "read", "s", "d", "assets/render-a.js"],
  ]);
});

test("reads inside functions, methods and class bodies across a cycle pass", async (t) => {
  const dir = await build(t, {
    "render-a.js": renderChunk,
    "editor-a.js":
      'import{a as Vn}from"./render-a.js";function f(){return new Vn}var g=()=>Vn,C=class{m(){return Vn}x=Vn};export{f as t};',
  });
  assert.deepEqual(faultsOf(dir), []);
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /No binding is read across a chunk cycle while it evaluates/);
});

test("calling a hoisted function across a cycle passes, but extending one does not", async (t) => {
  const dir = await build(t, {
    "render-a.js": 'import{t as e}from"./editor-a.js";function n(){return 1}export{n as a,e as b};',
    "editor-a.js": 'import{a as h}from"./render-a.js";var x=h(),C=class extends h{};export{x as t};',
  });
  assert.deepEqual(faultsOf(dir), [["assets/editor-a.js", "extends", "h", "a", "assets/render-a.js"]]);
});

test("top-level reads between chunks that do not form a cycle pass", async (t) => {
  const dir = await build(t, {
    "render-a.js": "var n=class{};export{n as a};",
    "editor-a.js": 'import{a as Vn}from"./render-a.js";var Ms=class extends Vn{};export{Ms as t};',
    "route-a.js": 'const m=()=>import(`./editor-a.js`);export{m as r};',
  });
  const { cycles, faults } = findChunkCycles([dir]);
  assert.deepEqual(cycles, []);
  assert.deepEqual(faults, []);
});

test("a missing build directory is an error, not a pass", () => {
  const result = spawnSync(process.execPath, [script, join(tmpdir(), "chunk-cycles-missing-build")], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Build directory not found/);
});
