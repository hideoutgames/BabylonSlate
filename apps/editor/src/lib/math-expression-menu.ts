import type { SerializedGraph } from "@haptic/core";
import type { NestedMenuItem } from "@haptic/editor-kit";
import { MATH_EXPRESSION_NODE_ID } from "@haptic/scripting";
import { defaultNodeRegistry } from "../services/graph-hydration";
import { catalogTypeId } from "../services/graph-node-refresh";
import { convertMathExpressionToNodes, convertToMathExpression, mathNodesConversionRefusal } from "./math-expression-convert";

const newId = () => crypto.randomUUID();

/**
 * The Class graph node menu's Math Expression actions for `selection` (the nodes the menu acts on):
 * **Convert to Math Nodes** on one Math Expression node (disabled while its formula has errors),
 * and **Convert to Math Expression** only when the selection converts exactly. Each commits one
 * graph change.
 */
export function mathExpressionMenuItems(
  graph: SerializedGraph,
  nodeId: string,
  selection: readonly string[],
  commit: (next: SerializedGraph) => void,
): NestedMenuItem[] {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) return [];
  if (catalogTypeId(node) === MATH_EXPRESSION_NODE_ID) {
    if (selection.length !== 1) return [];
    return [{
      id: "convert-math-nodes",
      label: "Convert to Math Nodes",
      testId: "graph-convert-math-nodes",
      disabled: mathNodesConversionRefusal(node) !== null,
      onSelect: () => {
        const next = convertMathExpressionToNodes(graph, nodeId, newId);
        if (next) commit(next);
      },
    }];
  }
  const converted = convertToMathExpression(graph, selection, defaultNodeRegistry(), newId());
  return converted ? [{
    id: "convert-math-expression",
    label: "Convert to Math Expression",
    testId: "graph-convert-math-expression",
    onSelect: () => commit(converted),
  }] : [];
}
