/** A wire from one node's output pin to another node's input pin, as Material and Particle graphs store it. */
export interface GraphPinEdge {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : "");

/** Serialized edges that name both ends; others are dropped, and an edge without an id gets `edge-<index>`. */
export function normalizeGraphPinEdges(value: unknown): GraphPinEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const sourceNodeId = text(record.sourceNodeId);
    const sourcePinId = text(record.sourcePinId);
    const targetNodeId = text(record.targetNodeId);
    const targetPinId = text(record.targetPinId);
    if (!sourceNodeId || !sourcePinId || !targetNodeId || !targetPinId) return [];
    return [{ id: text(record.id) || `edge-${index}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId }];
  });
}
