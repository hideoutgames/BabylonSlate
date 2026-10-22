import type { SerializedGraph } from "@haptic/core";
import type { LogicGraph, GraphNode, GraphEdge, GraphPin } from "./ir";
import { STRING, type PinType } from "./types";

/**
 * Read a saved graph: node pins come from `data.__pins` and every wire from
 * its `sourceHandle` / `targetHandle`. A wire without a handle keeps an empty
 * pin id, which validation reports as `ref.missing_pin`.
 */
export function fromSerializedGraph(
  graph: SerializedGraph,
  id = "main",
  kind: LogicGraph["kind"] = "event",
): LogicGraph {
  const nodes: GraphNode[] = graph.nodes.map((n) => ({
    id: n.id,
    typeId: n.type,
    position: n.position,
    pins: Array.isArray(n.data.__pins) ? (n.data.__pins as GraphPin[]) : [],
    properties: { ...n.data },
  }));
  const edges: GraphEdge[] = graph.edges.map((e, i) => ({
    id: e.id || `e${i}`,
    sourceNodeId: e.source,
    sourcePinId: e.sourceHandle ?? "",
    targetNodeId: e.target,
    targetPinId: e.targetHandle ?? "",
  }));
  return { id, kind, nodes, edges };
}

export function toSerializedGraph(graph: LogicGraph): SerializedGraph {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.typeId,
      position: n.position,
      data: { ...n.properties, __pins: n.pins },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      sourceHandle: e.sourcePinId,
      targetHandle: e.targetPinId,
    })),
  };
}

export function isLogicGraphPayload(
  value: unknown,
): value is LogicGraph {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as LogicGraph).nodes) &&
    Array.isArray((value as LogicGraph).edges) &&
    typeof (value as LogicGraph).id === "string"
  );
}

export function pinTypeFromJson(value: unknown): PinType {
  if (!value || typeof value !== "object") return STRING;
  return value as PinType;
}
