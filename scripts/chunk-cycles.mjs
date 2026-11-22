#!/usr/bin/env node
// Finds static import cycles between emitted JavaScript chunks and the module-evaluation-time reads of bindings
// imported across them. Inside a chunk cycle, whichever chunk the browser enters first has the other members evaluated
// before itself, so their top-level `class extends <imported>` (or any other top-level read of a binding it exports)
// sees an uninitialised value: `Class extends value undefined is not a constructor or null`.
//
// Usage:
//   node scripts/chunk-cycles.mjs [dist-dir ...]   # default apps/editor/dist
//
// Any member of a cycle may be entered first, so every top-level read of a binding imported from another member of the
// same cycle is reported, whatever the load order. Hoisted function declarations are initialised before evaluation and
// are exempt, except as an `extends` base. Reads inside function bodies run later and are ignored. Exits 1 when any
// reported read exists; a cycle without one is listed but passes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function listChunks(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listChunks(path));
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) out.push(path);
  }
  return out;
}

function chunkName(root, fromPath, specifier) {
  return relative(root, resolve(dirname(fromPath), specifier)).split(sep).join(posix.sep);
}

/**
 * One chunk's module structure: static imports in evaluation order (`{ from, bindings: Map<local, imported> }`),
 * exported names mapped to local bindings, and the locals that are hoisted functions.
 */
function readChunk(sourceFile, path, root) {
  const imports = [];
  const exports = new Map();
  const hoisted = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) hoisted.add(statement.name.text);
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause &&
      ts.isNamedExports(statement.exportClause))
      for (const element of statement.exportClause.elements)
        exports.set(element.name.text, (element.propertyName ?? element.name).text);
    const isImport = ts.isImportDeclaration(statement);
    const isReexport = ts.isExportDeclaration(statement) && statement.moduleSpecifier;
    if (!isImport && !isReexport) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const bindings = new Map();
    const clause = isImport ? statement.importClause : undefined;
    if (clause?.name) bindings.set(clause.name.text, "default");
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      bindings.set(clause.namedBindings.name.text, "*");
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const element of clause.namedBindings.elements)
        bindings.set(element.name.text, (element.propertyName ?? element.name).text);
    imports.push({ from: chunkName(root, path, specifier), bindings });
  }
  return { imports, exports, hoisted };
}

/** Tarjan's strongly connected components over `graph` (Map<node, node[]>); returns components of 2+ nodes. */
export function stronglyConnected(graph) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indices.set(node, index);
    low.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node);
  return components;
}

/**
 * Identifiers in `names` read while the module body evaluates: everything outside function bodies, plus class
 * `extends` clauses, computed member names, static field initialisers and static blocks.
 */
function evaluationTimeReads(sourceFile, names) {
  const reads = [];
  const record = (node, kind) => {
    if (ts.isIdentifier(node) && names.has(node.text))
      reads.push({ name: node.text, kind, offset: node.getStart(sourceFile) });
  };
  const visit = (node, kind) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      if (!ts.isFunctionDeclaration(node) && node.name && ts.isComputedPropertyName(node.name))
        visit(node.name, kind);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const clause of node.heritageClauses ?? [])
        for (const type of clause.types) visit(type.expression, "extends");
      for (const member of node.members) {
        if (member.name && ts.isComputedPropertyName(member.name)) visit(member.name, kind);
        const isStatic = ts.canHaveModifiers(member) &&
          ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
        if (ts.isPropertyDeclaration(member) && isStatic && member.initializer) visit(member.initializer, kind);
        if (ts.isClassStaticBlockDeclaration(member)) visit(member.body, kind);
      }
      return;
    }
    // Property names in `a.b` and `{ b: … }` are not reads of a binding named `b`.
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression, kind);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name, kind);
      visit(node.initializer, kind);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      record(node.name, kind);
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      record(node, kind);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, kind));
  };
  for (const statement of sourceFile.statements) visit(statement, "read");
  return reads;
}

/**
 * Chunk cycles under each `root` and the evaluation-time reads that cross them:
 * `{ cycles: [{ root, chunks }], faults: [{ root, chunk, from, name, imported, kind, line, column, excerpt }] }`.
 */
export function findChunkCycles(roots) {
  const cycles = [];
  const faults = [];
  for (const rootArg of roots) {
    const root = resolve(rootArg);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`Build directory not found: ${rootArg} (build it first)`);
    const chunks = new Map();
    for (const path of listChunks(root)) {
      const name = relative(root, path).split(sep).join(posix.sep);
      const sourceFile = ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
        ts.ScriptKind.JS);
      chunks.set(name, { sourceFile, ...readChunk(sourceFile, path, root) });
    }
    const graph = new Map([...chunks].map(([name, chunk]) => [name, chunk.imports.map((entry) => entry.from)]));
    for (const component of stronglyConnected(graph)) {
      cycles.push({ root: rootArg, chunks: component });
      const members = new Set(component);
      for (const name of component) {
        const { sourceFile, imports } = chunks.get(name);
        const origin = new Map();
        for (const entry of imports)
          if (members.has(entry.from))
            for (const [local, imported] of entry.bindings) origin.set(local, { from: entry.from, imported });
        for (const read of evaluationTimeReads(sourceFile, new Set(origin.keys()))) {
          const { from, imported } = origin.get(read.name);
          const exporter = chunks.get(from);
          const local = exporter.exports.get(imported);
          if (read.kind !== "extends" && local !== undefined && exporter.hoisted.has(local)) continue;
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(read.offset);
          faults.push({
            root: rootArg,
            chunk: name,
            from,
            name: read.name,
            imported,
            kind: read.kind,
            line: line + 1,
            column: character + 1,
            excerpt: sourceFile.text.slice(Math.max(0, read.offset - 60), read.offset + 80).replace(/\s+/g, " "),
          });
        }
      }
    }
  }
  return { cycles, faults };
}

export function formatReport({ cycles, faults }) {
  const lines = [];
  if (cycles.length === 0) lines.push("No chunk import cycles.");
  for (const cycle of cycles) lines.push(`Chunk cycle in ${cycle.root}: ${cycle.chunks.join(" <-> ")}`);
  if (cycles.length > 0 && faults.length === 0) lines.push("No binding is read across a chunk cycle while it evaluates.");
  for (const fault of faults)
    lines.push(
      `  ${fault.chunk}:${fault.line}:${fault.column} ${fault.kind === "extends" ? "extends" : "reads"} ` +
        `\`${fault.name}\` (export \`${fault.imported}\` of ${fault.from}, in the same cycle) while it evaluates: ` +
        `…${fault.excerpt}…`,
    );
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const roots = process.argv.slice(2);
  const report = findChunkCycles(roots.length > 0 ? roots : ["apps/editor/dist"]);
  console.log(formatReport(report));
  if (report.faults.length > 0) process.exitCode = 1;
}
