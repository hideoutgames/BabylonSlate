import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Source audit (the source text is the contract): the runtime packages declare `"sideEffects"`, so a bundler drops a
 * module none of whose exports a game uses. A module that registers something when it loads (a Babylon class, a
 * material plugin, a shader, a worker handler) or that another module imports only for its effect would then vanish
 * from the player without an error. Each such file must be listed in its package's `sideEffects`, and nothing else.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_PACKAGES = [
  "core", "assets", "bridge", "exporter", "physics", "navigation", "runtime", "render", "vfs",
  "anim-graph", "behaviour-tree", "shader-graph", "particle-graph", "object-model",
] as const;

type Manifest = { name: string; exports?: Record<string, string>; sideEffects?: boolean | string[] };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(file));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|bench)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(file);
  }
  return out;
}

function manifest(pkg: string): Manifest {
  return JSON.parse(readFileSync(path.join(repoRoot, "packages", pkg, "package.json"), "utf8")) as Manifest;
}

/** Top-level statements that run code when the module loads, and the specifiers it imports only for their effect. */
function loadEffects(file: string): { runsCode: boolean; bareImports: string[] } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  let runsCode = false;
  const bareImports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause) bareImports.push((statement.moduleSpecifier as ts.StringLiteral).text);
      continue;
    }
    if (ts.isExpressionStatement(statement) || ts.isIfStatement(statement) || ts.isIterationStatement(statement, false) ||
      ts.isTryStatement(statement) || ts.isBlock(statement)) runsCode = true;
  }
  return { runsCode, bareImports };
}

describe("runtime package sideEffects", () => {
  const byName = new Map(RUNTIME_PACKAGES.map((pkg) => [manifest(pkg).name, pkg]));
  const required = new Map<string, Set<string>>(RUNTIME_PACKAGES.map((pkg) => [pkg, new Set()]));
  const resolveBare = (from: string, specifier: string): [string, string] | null => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(from), specifier);
      const file = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((candidate) => {
        try { return readFileSync(candidate) !== null; } catch { return false; }
      });
      const pkg = file && RUNTIME_PACKAGES.find((name) => file.startsWith(path.join(repoRoot, "packages", name, "src") + path.sep));
      return file && pkg ? [pkg, file] : null;
    }
    const match = /^(@haptic\/[^/]+)(\/.*)?$/.exec(specifier);
    const pkg = match ? byName.get(match[1]!) : undefined;
    if (!pkg) return null;
    const target = manifest(pkg).exports?.[`.${match![2] ?? ""}`];
    return target ? [pkg, path.join(repoRoot, "packages", pkg, target)] : null;
  };
  const importers = [
    ...RUNTIME_PACKAGES.map((pkg) => path.join(repoRoot, "packages", pkg, "src")),
    path.join(repoRoot, "apps/player/src"),
    path.join(repoRoot, "apps/editor/src"),
  ];
  for (const dir of importers) {
    for (const file of sourceFiles(dir)) {
      const effects = loadEffects(file);
      const own = RUNTIME_PACKAGES.find((name) => file.startsWith(path.join(repoRoot, "packages", name, "src") + path.sep));
      if (own && effects.runsCode) required.get(own)!.add(file);
      for (const specifier of effects.bareImports) {
        const target = resolveBare(file, specifier);
        if (target) required.get(target[0])!.add(target[1]);
      }
    }
  }

  it.each(RUNTIME_PACKAGES)("%s lists exactly the modules that act when they load", (pkg) => {
    const declared = manifest(pkg).sideEffects;
    const expected = [...required.get(pkg)!].map((file) => `./${path.relative(path.join(repoRoot, "packages", pkg), file).split(path.sep).join("/")}`).sort();
    if (expected.length === 0) expect(declared).toBe(false);
    else expect(Array.isArray(declared) ? [...declared].sort() : declared).toEqual(expected);
  });
});
