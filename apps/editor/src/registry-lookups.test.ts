import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-read audit: how editor code finds one asset is the contract here.
// `AssetRegistry.list()` copies every entry into a new array on each call, so
// finding one asset by guid or path through it costs a whole-registry copy per
// render or per document, where `getByGuid` / `getByPath` read a map.
const SRC = dirname(fileURLToPath(import.meta.url));
const SINGLE_LOOKUP = /\.list\(\)(?:\s*\?\?\s*\[\]\s*\))?\s*\.(?:find|filter)\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.(?:path|header\.guid)\s*===/g;
/** Test-build hooks and harnesses; the Animation editor's lookups change with its source loading. */
const EXEMPT = new Set(["components/animation-editor.tsx", "context/document-test-hooks.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("asset registry lookups", () => {
  it("find one asset by guid or path through the registry's maps, never by scanning list()", () => {
    const files = sourceFiles(SRC);
    // The walk reaches the editor's screens, so an empty result is a finding.
    expect(files.map((file) => relative(SRC, file))).toContain("components/audio-editor.tsx");
    const scans = files.flatMap((file) => {
      const name = relative(SRC, file);
      if (EXEMPT.has(name)) return [];
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(SINGLE_LOOKUP)].map((match) => `${name}:${source.slice(0, match.index).split("\n").length}`);
    });
    expect(scans).toEqual([]);
  });
});
