import type { LogicGraph, GraphNode, GraphPin } from "./ir";
import { findPin } from "./ir";
import { tagRuntimeSource } from "./tags";
import type { CompileOptions, CompileResult } from "./compile-types";
import { createCodegenState, emitBody, entryDeclarations, type CodegenState } from "./compile-codegen-state";
import { ensurePure, inputExpression } from "./compile-expressions";
import { disconnectedPinLiteral } from "./compile-pin-values";

const ANIM_RULE_SINKS = [
  {
    typeId: "anim.rule.enterState",
    key: "enter",
    pinName: "value",
  },
  {
    typeId: "anim.rule.exitState",
    key: "exit",
    pinName: "value",
  },
] as const;

/**
 * What a rule sink reads. Unwired, or wired to a node that is missing, stripped or not pure, it
 * allows the transition unless a default is authored on the pin.
 */
function sinkExpression(s: CodegenState, node: GraphNode, pin: GraphPin): string {
  const edge = s.index.incoming(node.id, pin.id);
  const source = edge && s.index.node(edge.sourceNodeId);
  const readable = source && findPin(source, edge.sourcePinId) && !s.shouldStrip(source) &&
    s.options.registry.get(source.typeId)?.pure === true;
  return readable ? inputExpression(s, node, pin) : disconnectedPinLiteral(node, pin, s.options.registry, "true");
}

/**
 * Compile a pure animation transition graph into `evaluate(ctx) => { enter, exit }`.
 * Disconnected Enter State / Exit State inputs default to true.
 *
 * The expressions come from the Class graph compiler (`compile-expressions`), so a rule's nodes
 * compile exactly as they do in a Class: subjects are guarded, constants fold, and an output two
 * wires read is evaluated once per `evaluate` call, which is one statement.
 */
export function compileTransitionRuleGraph(
  graph: LogicGraph,
  options: CompileOptions,
): CompileResult {
  // A rule has no exec chain to trace or break on, and no loop to guard.
  const s = createCodegenState(graph, { ...options, instrumentExecutionTrace: false, instrumentInfiniteLoops: false });
  graph = s.graph;
  for (const node of graph.nodes) {
    if (options.registry.get(node.typeId)?.pure) ensurePure(s, node);
  }

  const results: Record<string, string> = {};
  for (const sink of ANIM_RULE_SINKS) {
    const node = graph.nodes.find((entry) => entry.typeId === sink.typeId);
    if (!node || node.properties.__disabled === true) {
      results[sink.key] = "true";
      continue;
    }
    const pin = node.pins.find(
      (entry) => entry.name === sink.pinName && entry.direction === "in",
    );
    results[sink.key] = pin ? sinkExpression(s, node, pin) : "true";
  }

  const tagPreamble = graph.nodes.some((node) => node.typeId.startsWith("tags."))
    ? tagRuntimeSource(options.tagRegistry).split("\n") : [];
  const hoistedLines = s.hoisted.flatMap((chunk) => chunk.source.split("\n"));
  emitBody(s, `  return { enter: (${results.enter}), exit: (${results.exit}) };`);
  const source = [
    `//# sourceURL=haptic:///${options.assetGuid}.js`,
    ...tagPreamble,
    ...hoistedLines,
    `export function evaluate(ctx) {`,
    // Only what the two results read: a node wired to neither costs nothing per evaluation.
    ...entryDeclarations(s),
    ...s.outputDecls.values(),
    ...s.body.map((line) => line.text),
    `}`,
    "",
  ].join("\n");

  return {
    source,
    anchors: [
      {
        line: 2 + tagPreamble.length + hoistedLines.length,
        column: 1,
        assetGuid: options.assetGuid,
        graphId: graph.id,
        nodeId:
          graph.nodes.find((entry) => entry.typeId === "anim.rule.exitState")
            ?.id ??
          graph.nodes.find((entry) => entry.typeId === "anim.rule.enterState")
            ?.id ??
          graph.id,
      },
    ],
    exportName: "evaluate",
    isAsync: false,
    entryPoints: [
      {
        name: "evaluate",
        event: "onAnimRule",
        isAsync: false,
        nodeId: graph.nodes.find(
          (entry) => entry.typeId === "anim.rule.exitState",
        )?.id,
      },
    ],
  };
}
