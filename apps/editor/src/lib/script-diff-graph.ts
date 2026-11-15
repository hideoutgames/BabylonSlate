import type { GraphDocument } from "@haptic/graph-ui";
import { defaultNodeRegistry, hydrateSerializedGraphForEditor } from "../services/graph-hydration";

type Node = GraphDocument["nodes"][number];

function storedPins(node: Node | undefined): unknown[] | null {
  const pins = node?.data.__pins;
  return Array.isArray(pins) && pins.length > 0 ? pins : null;
}

/**
 * One stored version of a script graph (a Class's, the Scene Script, an
 * Animation Graph's state, rule and Animation Object graphs) as the graph
 * editor draws it, for the Diff window: each node keeps the pins the editor
 * saved with it, and a node stored without them (a graph never edited, such
 * as a new state's) takes the node registry's, as the graph windows hydrate it.
 */
export function scriptDiffGraph(stored: unknown): GraphDocument {
  const graph = stored as Partial<GraphDocument> | null;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { nodes: [], edges: [] };
  const plain = { nodes: graph.nodes, edges: graph.edges };
  if (plain.nodes.every((node) => storedPins(node))) return plain;
  const byId = new Map(plain.nodes.map((node) => [node.id, node]));
  const hydrated = hydrateSerializedGraphForEditor(plain, defaultNodeRegistry());
  return {
    ...hydrated,
    nodes: hydrated.nodes.map((node) => {
      const pins = storedPins(byId.get(node.id));
      return pins ? { ...node, data: { ...node.data, __pins: pins } } : node;
    }),
  };
}
