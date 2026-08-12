import type { SerializedGraph } from "@babylonslate/core";

/** Pin metadata embedded in node data by @babylonslate/scripting serialize. */
export type SerializedPin = {
  id: string;
  name: string;
  kind: "exec" | "data";
  direction: "in" | "out";
  type: { kind: string; [key: string]: unknown };
  optional?: boolean;
};

/** Serialized graph with optional pin handles on edges (backward compatible with core). */
export type GraphEdge = SerializedGraph["edges"][number] & {
  sourceHandle?: string;
  targetHandle?: string;
};

export type GraphDocument = Omit<SerializedGraph, "edges"> & {
  edges: GraphEdge[];
};

export type GraphDiagnostic = {
  nodeId?: string;
  pinId?: string;
  severity: string;
  message: string;
};

export type PaletteNode = {
  id: string;
  title: string;
  category: string;
};

export type NavigateRequest = {
  nodeId?: string;
  pinId?: string;
};

export function hasSerializedPins(
  data: Record<string, unknown> | undefined,
): data is Record<string, unknown> & { __pins: SerializedPin[] } {
  return Array.isArray(data?.__pins);
}
