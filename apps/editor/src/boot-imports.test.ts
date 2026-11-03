import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-read audit: the editor's static relative imports are the contract
// here. The editor package has no `sideEffects` declaration, so every module
// a boot module imports statically, even through a re-export barrel, is in
// the Homepage's preload; `import type` and `import()` are not.
const SRC = dirname(fileURLToPath(import.meta.url));
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;

function resolveModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Editor modules `main.tsx` reaches through static relative imports. */
function bootClosure(): Set<string> {
  const seen = new Set<string>();
  const stack = [join(SRC, "main.tsx")];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const next = resolveModule(file, match[1]!);
      if (next) stack.push(next);
    }
  }
  return seen;
}

describe("editor boot imports", () => {
  it("keep the Content Browser helpers barrel and its New Asset factories out of the Homepage preload", () => {
    const closure = [...bootClosure()].map((file) => relative(SRC, file));
    // The audit follows the provider's services, so an empty result is a finding.
    expect(closure).toContain("services/project-service.ts");
    expect(closure).toContain("services/play-content-service.ts");
    expect(closure.filter((file) => file === "lib/content-browser-helpers.ts" || file === "lib/new-asset-result.ts")).toEqual([]);
  });
});
