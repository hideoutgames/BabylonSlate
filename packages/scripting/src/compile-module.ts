import type { GraphNode, LogicGraph } from "./ir";
import { tagRuntimeSource } from "./tags";
import type {
  CompileAnchor,
  CompiledEntryPoint,
  CompileOptions,
  CompileResult,
} from "./compile-types";
import { eventNameForEntry } from "./compile-events";
import {
  beginEntry,
  emitBody,
  type BodyLine,
  type CodegenState,
  type HoistChunk,
} from "./compile-codegen-state";
import { ensurePure } from "./compile-expressions";
import { emitExecChain } from "./compile-exec-chain";

/** Words a strict-mode module cannot use as a function declaration name. */
const RESERVED_WORDS = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package",
  "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield",
]);

/** The runtime dispatches events by `CompiledEntryPoint.event`, so only the export is renamed. */
function exportIdent(name: string): string {
  return RESERVED_WORDS.has(name) ? `${name}_` : name;
}

/** The module's first lines: its source URL, the probe helpers and the Tag runtime. */
export function modulePreamble(graph: LogicGraph, options: CompileOptions): string[] {
  const preamble = [`//# sourceURL=haptic:///${options.assetGuid}.js`];
  // `var` stays valid when a document concatenates its graphs' modules.
  if (options.instrumentExecutionTrace === true && options.stripDevelopmentOnly !== true) {
    preamble.push("var __dv = (t, node, pin, value) => (t === null ? value : t.read(node, pin, value));");
    preamble.push("var __dw = (t, node, pin, value) => (t === null ? value : (t.write(node, pin, value), value));");
  }
  if (options.instrumentBreakpoints === true && options.stripDevelopmentOnly !== true) {
    preamble.push("var __bv = (b, node, pin, value) => (b === null ? value : b.read(node, pin, value));");
  }
  if (graph.nodes.some((node) => node.typeId.startsWith("tags."))) {
    preamble.push(...tagRuntimeSource(options.tagRegistry).split("\n"));
  }
  return preamble;
}

/** One exported function: its entry point, function-scope declarations and statements. */
export type CompiledEntry = {
  entry: CompiledEntryPoint;
  declLines: string[];
  bodyLines: BodyLine[];
};

/** Emits the function for `entry`; `null` is the single export of a graph without one. */
export function compileEntry(
  s: CodegenState,
  entry: GraphNode | null,
  exportName: string,
  usedNames: Set<string>,
): CompiledEntry {
  beginEntry(s);

  for (const node of s.graph.nodes) {
    if (s.shouldStrip(node)) continue;
    if (s.options.registry.get(node.typeId)?.pure) ensurePure(s, node);
  }
  s.useEpoch = s.memoDecls.length > 0;

  s.entryNodeId = entry?.id ?? "";
  if (entry) emitExecChain(s, entry.id);
  else emitBody(s, `  // empty graph`);

  const name = uniqueName(
    entry ? entryExportName(entry, exportName) : exportName,
    usedNames,
  );
  return {
    entry: {
      name,
      event: entry ? eventNameForEntry(entry) : undefined,
      nodeId: entry?.id,
      ...(entry ? { graphId: s.graph.id } : {}),
      isAsync: s.isAsync,
      ...(entry ? entryComponentId(entry) : {}),
    },
    declLines: [
      ...(s.traceExecution
        ? [`  const __dbg = ctx.debugTrace === null ? null : ctx.debugTrace.graph(${JSON.stringify(s.options.assetGuid)}, ${JSON.stringify(s.graph.id)});`]
        : []),
      ...(s.checkBreakpoints
        ? [`  const __bp = ctx.breakpoints === null ? null : ctx.breakpoints.graph(${JSON.stringify(s.options.assetGuid)}, ${JSON.stringify(s.graph.id)});`]
        : []),
      ...s.outputDecls.values(),
      ...s.pureExpressions.declarations,
      ...(s.memoDecls.length > 0 ? ["  let __stmt = 0;", ...s.memoDecls] : []),
    ],
    bodyLines: s.body.filter((line) => line.text !== ""),
  };
}

/** Joins the preamble, hoisted chunks and entry functions into the module and its anchors. */
export function assembleModule(
  s: CodegenState,
  preamble: string[],
  compiledEntries: CompiledEntry[],
  exportName: string,
): CompileResult {
  const finalLines = [...preamble];
  const anchors: CompileAnchor[] = [];

  // Chunks without body anchors (math helpers) go first. A stack frame inside
  // one then has no preceding anchor, so error mapping falls through to the
  // calling statement instead of landing on an earlier ExecuteJavaScript body.
  const hasBodyAnchors = (chunk: HoistChunk) => (chunk.bodyAnchors?.length ?? 0) > 0;
  for (const chunk of [
    ...s.hoisted.filter((entry) => !hasBodyAnchors(entry)),
    ...s.hoisted.filter(hasBodyAnchors),
  ]) {
    const lines = chunk.source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      finalLines.push(lines[i]!);
      const bodyAnchor = chunk.bodyAnchors?.find(
        (entry) => entry.relativeLine === i + 1,
      );
      if (bodyAnchor) {
        anchors.push({
          line: finalLines.length,
          column: 1,
          assetGuid: s.options.assetGuid,
          graphId: s.graph.id,
          nodeId: chunk.nodeId,
          bodyLine: bodyAnchor.bodyLine,
        });
      }
    }
  }

  for (const compiled of compiledEntries) {
    finalLines.push(
      `export ${compiled.entry.isAsync ? "async " : ""}function ${compiled.entry.name}(ctx) {`,
    );
    const preamble = s.options.localPreamble ?? [];
    if (preamble.length) {
      finalLines.push(...preamble);
    }
    finalLines.push(...compiled.declLines);
    // A waiting latent frame holds its locals in a promise the engine cannot
    // see; registering them keeps the objects they hold alive meanwhile.
    const held = compiled.entry.isAsync ? declaredLocals([...preamble, ...compiled.declLines]) : [];
    if (held.length > 0) {
      finalLines.push(`  const __haptic_frame = ctx.holdFrame?.(() => [${held.join(", ")}]);`, `  try {`);
    }
    for (const line of compiled.bodyLines) {
      finalLines.push(line.text);
      if (line.anchor) {
        anchors.push({ ...line.anchor, line: finalLines.length });
      }
    }
    if (held.length > 0) finalLines.push(`  } finally { __haptic_frame?.(); }`);
    finalLines.push(`}`);
  }

  return {
    source: finalLines.join("\n") + "\n",
    anchors,
    exportName: compiledEntries[0]?.entry.name ?? exportName,
    isAsync: compiledEntries.some((c) => c.entry.isAsync),
    entryPoints: compiledEntries.map((c) => c.entry),
  };
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let index = 2;
  while (used.has(name)) name = `${base}_${index++}`;
  used.add(name);
  return name;
}

function entryExportName(entry: GraphNode, fallback: string): string {
  const event = eventNameForEntry(entry);
  return event === undefined ? fallback : exportIdent(event);
}

function entryComponentId(entry: GraphNode): { componentId?: string } {
  const id = entry.properties.componentId;
  if (typeof id !== "string" || !id.trim()) return {};
  return { componentId: id.trim() };
}

/** Names declared by `let` lines: locals, node outputs and subject slots. */
function declaredLocals(lines: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    const match = /^\s*let\s+([^;=]+)/.exec(line);
    if (!match) continue;
    for (const part of match[1]!.split(",")) {
      const name = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
}
