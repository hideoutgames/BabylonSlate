import type { SerializedGraph } from "@babylonslate/shared";
import { engineCommandBus } from "@babylonslate/shared";

export function serializeGraph(graph: SerializedGraph): string {
  return JSON.stringify(graph, null, 2);
}

export function deserializeGraph(raw: string): SerializedGraph {
  return JSON.parse(raw) as SerializedGraph;
}

export function executeGraph(graph: SerializedGraph): void {
  for (const node of graph.nodes) {
    if (node.type === "logMessage") {
      const message = String(node.data.message ?? "");
      engineCommandBus.dispatch({ type: "log", message });
    }
  }
}
