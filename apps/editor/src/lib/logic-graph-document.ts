import type { SerializedGraph } from "@babylonslate/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!isRecord(value)) return false;
  return Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Logic graph stored on a Class document or UserInterface `payload.logic`. */
export function serializedGraphFromDocument(
  kind: string,
  content: unknown,
): SerializedGraph | null {
  if (kind === "graph") {
    return isSerializedGraph(content) ? content : null;
  }
  if (kind === "ui" && isRecord(content)) {
    return isSerializedGraph(content.logic) ? content.logic : null;
  }
  return null;
}

/** Write a logic graph back onto a Class body or UserInterface payload. */
export function replaceSerializedGraphInDocument(
  kind: string,
  content: unknown,
  next: SerializedGraph,
): unknown {
  if (kind === "graph") return next;
  if (kind === "ui" && isRecord(content)) {
    return { ...content, logic: next };
  }
  return next;
}
