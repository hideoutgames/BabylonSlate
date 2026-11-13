import type { GraphNode, GraphPin, LogicGraph } from "./ir";
import { findPin } from "./ir";
import { tagRuntimeSource } from "./tags";
import type { CompileOptions, CompileResult } from "./compile-types";
import { createCodegenState, emitBody, entryDeclarations, type CodegenState } from "./compile-codegen-state";
import { ensurePure, inputExpression } from "./compile-expressions";

/** Animation Graph pose and frame nodes: their data inputs are what a pose-data module computes. */
export function isAnimPoseNodeType(typeId: string): boolean {
  return typeId.startsWith("anim.pose.") || typeId.startsWith("anim.frame.") || typeId.startsWith("anim.control.");
}

function isStructuralPin(pin: GraphPin): boolean {
  return pin.type.kind === "pose" || pin.type.kind === "frame";
}

/** A wired data input whose source compiles: a present, unstripped, pure node. */
function compiledInput(s: CodegenState, node: GraphNode, pin: GraphPin): string | null {
  const edge = s.index.incoming(node.id, pin.id);
  const source = edge && s.index.node(edge.sourceNodeId);
  const readable = source && findPin(source, edge.sourcePinId) && !s.shouldStrip(source) &&
    s.options.registry.get(source.typeId)?.pure === true;
  return readable ? inputExpression(s, node, pin) : null;
}

/**
 * Compile a pose (or frame) graph's data into `evaluate(ctx) => { [nodeId]: { [pinName]: value } }`, holding only
 * the wired data inputs of its pose nodes. Unwired inputs are not listed: the evaluator reads their stored
 * defaults, so a graph with no wired data input compiles to nothing (null) and needs no module call. The pose wires
 * themselves are read as structure by `@haptic/anim-graph`.
 */
export function compilePoseDataGraph(graph: LogicGraph, options: CompileOptions): CompileResult | null {
  const s = createCodegenState(graph, { ...options, instrumentExecutionTrace: false, instrumentInfiniteLoops: false });
  graph = s.graph;
  for (const node of graph.nodes) {
    if (options.registry.get(node.typeId)?.pure) ensurePure(s, node);
  }
  const entries: string[] = [];
  for (const node of graph.nodes) {
    if (!isAnimPoseNodeType(node.typeId) || s.shouldStrip(node)) continue;
    const values: string[] = [];
    for (const pin of node.pins) {
      if (pin.direction !== "in" || pin.kind !== "data" || isStructuralPin(pin)) continue;
      const expression = compiledInput(s, node, pin);
      if (expression) values.push(`${JSON.stringify(pin.name)}: (${expression})`);
    }
    if (values.length > 0) entries.push(`${JSON.stringify(node.id)}: { ${values.join(", ")} }`);
  }

  if (entries.length === 0) return null;
  const tagPreamble = graph.nodes.some((node) => node.typeId.startsWith("tags."))
    ? tagRuntimeSource(options.tagRegistry).split("\n") : [];
  const hoistedLines = s.hoisted.flatMap((chunk) => chunk.source.split("\n"));
  emitBody(s, `  return { ${entries.join(", ")} };`);
  const source = [
    `//# sourceURL=haptic:///${options.assetGuid}.js`,
    ...tagPreamble,
    ...hoistedLines,
    `export function evaluate(ctx) {`,
    ...entryDeclarations(s),
    ...s.outputDecls.values(),
    ...s.body.map((line) => line.text),
    `}`,
    "",
  ].join("\n");
  const output = graph.nodes.find((node) => node.typeId === "anim.pose.output" || node.typeId === "anim.frame.output");
  return {
    source,
    anchors: [{
      line: 2 + tagPreamble.length + hoistedLines.length,
      column: 1,
      assetGuid: options.assetGuid,
      graphId: graph.id,
      nodeId: output?.id ?? graph.id,
    }],
    exportName: "evaluate",
    isAsync: false,
    entryPoints: [{ name: "evaluate", event: "onAnimPose", isAsync: false, nodeId: output?.id }],
  };
}
