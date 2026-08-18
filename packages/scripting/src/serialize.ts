import type { SerializedGraph } from "@babylonslate/core";
import type { LogicGraph, GraphNode, GraphEdge } from "./ir";
import { BOOL, EXEC, STRING, type PinType } from "./types";
import { pin } from "./node-registry";

/**
 * Adapt legacy SerializedGraph (no pin ends) into LogicGraph.
 * logMessage nodes become debug.log with a string message property.
 */
export function fromSerializedGraph(
  graph: SerializedGraph,
  id = "main",
  kind: LogicGraph["kind"] = "event",
): LogicGraph {
  const nodes: GraphNode[] = graph.nodes.map((n) => {
    if (n.type === "logMessage" || n.type === "debug.log") {
      const data = (n.data ?? {}) as Record<string, unknown>;
      return {
        id: n.id,
        typeId: "debug.log",
        position: n.position,
        pins: [
          pin("execIn", "exec", "in", EXEC),
          pin("execOut", "then", "out", EXEC),
          pin("message", "message", "in", STRING, "data", true),
        ],
        properties: {
          ...data,
          message: String(data["default:message"] ?? data.message ?? ""),
          severity: data.severity ?? "log",
          category: data.category ?? "Script",
        },
      };
    }
    return {
      id: n.id,
      typeId: n.type,
      position: n.position,
      pins: inferPinsFromData(n.data),
      properties: { ...(n.data as Record<string, unknown>) },
    };
  });

  // Legacy edges lack pin ids — connect first exec out → first exec in when both exist.
  const edges: GraphEdge[] = graph.edges.map((e, i) => {
    const source = nodes.find((n) => n.id === e.source);
    const target = nodes.find((n) => n.id === e.target);
    const sourcePin =
      source?.pins.find((p) => p.kind === "exec" && p.direction === "out") ??
      source?.pins.find((p) => p.direction === "out");
    const targetPin =
      target?.pins.find((p) => p.kind === "exec" && p.direction === "in") ??
      target?.pins.find((p) => p.direction === "in");
    return {
      id: e.id || `e${i}`,
      sourceNodeId: e.source,
      sourcePinId: sourcePin?.id ?? "out",
      targetNodeId: e.target,
      targetPinId: targetPin?.id ?? "in",
    };
  });

  return { id, kind, nodes, edges };
}

function inferPinsFromData(
  data: Record<string, unknown>,
): GraphNode["pins"] {
  const pins = [
    pin("execIn", "exec", "in", EXEC),
    pin("execOut", "then", "out", EXEC),
  ];
  if (typeof data.condition === "boolean") {
    pins.push(pin("condition", "condition", "in", BOOL));
  }
  return pins;
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
  } as SerializedGraph & {
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
    }>;
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
