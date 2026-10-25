import type { LogicGraph } from "./ir";
import { entryNodes } from "./compiled-nodes";
import type { CompileOptions, CompileResult } from "./compile-types";
import { createCodegenState } from "./compile-codegen-state";
import {
  assembleModule,
  compileEntry,
  modulePreamble,
  type CompiledEntry,
} from "./compile-module";

export type {
  CompileAnchor,
  ScriptEventName,
  CompiledEntryPoint,
  CompileResult,
  CompileOptions,
} from "./compile-types";
export {
  EVENT_BY_TYPE_ID,
  isTouchEventNodeType,
  eventNameForEntry,
  localVariableIdent,
} from "./compile-events";
export { compileTransitionRuleGraph } from "./compile-transition-rule";

/**
 * Deterministic JS module compiler with line/column anchors.
 */
export function compileGraph(
  graph: LogicGraph,
  options: CompileOptions,
): CompileResult {
  const s = createCodegenState(graph, options);
  const exportName = options.exportName ?? "run";
  const preamble = modulePreamble(s.graph, options);
  const entries = entryNodes(s.graph);
  const compiledEntries: CompiledEntry[] = [];
  const usedNames = new Set<string>();

  for (const entry of entries.length > 0 ? entries : [null]) {
    if (entry && s.shouldStrip(entry)) continue;
    compiledEntries.push(compileEntry(s, entry, exportName, usedNames));
  }

  return assembleModule(s, preamble, compiledEntries, exportName);
}
