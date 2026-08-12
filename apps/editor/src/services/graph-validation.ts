import type { SerializedGraph } from "@babylonslate/core";
import {
  fromSerializedGraph,
  validateGraphs,
  hasBlockingErrors,
  type Diagnostic,
  isLogicGraphPayload,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";

const registry = createDefaultNodeRegistry();

export function materializeLogicGraph(
  content: SerializedGraph | LogicGraph,
  graphId: string,
): LogicGraph {
  if (isLogicGraphPayload(content)) return content;
  // Prefer pins embedded in node data from scripting serialize.
  const nodes = content.nodes.map((n) => {
    const pins = (n.data as { __pins?: LogicGraph["nodes"][0]["pins"] }).__pins;
    if (!pins) return n;
    return n;
  });
  void nodes;
  const logic = fromSerializedGraph(content, graphId);
  // Overlay __pins when present.
  for (let i = 0; i < logic.nodes.length; i++) {
    const data = content.nodes[i]?.data as
      | { __pins?: LogicGraph["nodes"][0]["pins"]; __nodeType?: string }
      | undefined;
    if (data?.__pins) {
      logic.nodes[i] = {
        ...logic.nodes[i]!,
        pins: data.__pins,
        typeId: data.__nodeType ?? logic.nodes[i]!.typeId,
      };
    } else {
      const def = registry.get(logic.nodes[i]!.typeId);
      if (def) {
        logic.nodes[i] = {
          ...logic.nodes[i]!,
          pins: def.pins(logic.nodes[i]!.properties),
        };
      }
    }
  }
  // Rebuild edges from handles when present on SerializedGraph.
  const rawEdges = content.edges as Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
  logic.edges = rawEdges.map((e, i) => ({
    id: e.id || `e${i}`,
    sourceNodeId: e.source,
    sourcePinId: e.sourceHandle ?? logic.edges[i]?.sourcePinId ?? "execOut",
    targetNodeId: e.target,
    targetPinId: e.targetHandle ?? logic.edges[i]?.targetPinId ?? "execIn",
  }));
  return logic;
}

export function validateSerializedGraph(
  content: SerializedGraph | LogicGraph,
  options: { assetGuid: string; graphId: string },
): Diagnostic[] {
  const graph = materializeLogicGraph(content, options.graphId);
  return validateGraphs([graph], { assetGuid: options.assetGuid });
}

export function projectHasBlockingErrors(
  diagnostics: readonly Diagnostic[],
): boolean {
  return hasBlockingErrors(diagnostics);
}

export { registry as defaultNodeRegistry };
