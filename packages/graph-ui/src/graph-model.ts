import type { GraphDocument, GraphEdge } from "./graph-types";

export const DEFAULT_NODE_TYPE = "logMessage";

interface CanvasNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: unknown;
}

const NODE_TYPE_KEY = "__nodeType";

function serializedNodeType(node: CanvasNode): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (typeof data[NODE_TYPE_KEY] === "string") {
    return data[NODE_TYPE_KEY];
  }
  return node.type ?? DEFAULT_NODE_TYPE;
}

function serializedNodeData(data: unknown): Record<string, unknown> {
  const raw = (data ?? {}) as Record<string, unknown>;
  if (!(NODE_TYPE_KEY in raw)) {
    return raw;
  }
  const rest = { ...raw };
  delete rest[NODE_TYPE_KEY];
  return rest;
}

const PROTECTED_NODE_TYPES = new Set([
  "flow.function.input",
  "flow.function.output",
]);

export function isProtectedNode(node: {
  type?: string;
  data?: unknown;
}): boolean {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (data.__protected === true) return true;
  const type =
    typeof data.__nodeType === "string" ? data.__nodeType : node.type;
  return typeof type === "string" && PROTECTED_NODE_TYPES.has(type);
}

export function deletableNodeIds(
  nodes: ReadonlyArray<{ id: string; selected?: boolean; data?: unknown; type?: string }>,
): string[] {
  return nodes
    .filter((node) => node.selected && !isProtectedNode(node))
    .map((node) => node.id);
}

/**
 * Projects React Flow's canvas nodes back onto the serialized graph shape.
 * Kept pure so it is testable without mounting a canvas.
 */
export function toSerializedGraph(
  nodes: CanvasNode[],
  edges: GraphEdge[],
  extras?: Pick<GraphDocument, "members" | "components">,
): GraphDocument {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: serializedNodeType(node),
      position: node.position,
      data: serializedNodeData(node.data),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    })),
    ...(extras?.members && extras.members.length > 0
      ? { members: extras.members }
      : {}),
    ...(Array.isArray(extras?.components)
      ? { components: extras.components }
      : {}),
  };
}

export type ReconcileCanvasNode = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: unknown;
  selected?: boolean;
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
};

export type ReconcileCanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => key !== NODE_TYPE_KEY)
      .sort();
    const next: Record<string, unknown> = {};
    for (const key of keys) {
      next[key] = stableJsonValue(record[key]);
    }
    return next;
  }
  return value;
}

/**
 * Structural fingerprint of nodes and edges. Ignores React Flow chrome and
 * `__nodeType` (moved onto `type` by serialization).
 */
export function canonicalGraphSignature(graph: GraphDocument): string {
  const nodes = graph.nodes
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      data: stableJsonValue(node.data),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = graph.edges
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({ nodes, edges });
}

function graphFromCanvas(
  localNodes: readonly ReconcileCanvasNode[],
  localEdges: readonly ReconcileCanvasEdge[],
): GraphDocument {
  return toSerializedGraph(
    localNodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
    })),
    localEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    })),
  );
}

/**
 * Apply an external document graph (undo/redo, inspector) onto the canvas.
 * Returns null when `incoming` is the local graph or an echo of the last emit,
 * so in-progress drags are not snapped back.
 */
export function reconcileCanvasGraph(options: {
  localNodes: readonly ReconcileCanvasNode[];
  localEdges: readonly ReconcileCanvasEdge[];
  incoming: GraphDocument;
  lastEmitted?: GraphDocument | null;
}): { nodes: ReconcileCanvasNode[]; edges: ReconcileCanvasEdge[] } | null {
  const incomingSig = canonicalGraphSignature(options.incoming);
  if (
    options.lastEmitted &&
    incomingSig === canonicalGraphSignature(options.lastEmitted)
  ) {
    return null;
  }
  const localDoc = graphFromCanvas(options.localNodes, options.localEdges);
  if (incomingSig === canonicalGraphSignature(localDoc)) {
    return null;
  }

  const localById = new Map(
    options.localNodes.map((node) => [node.id, node]),
  );
  const nodes = options.incoming.nodes.map((node) => {
    const local = localById.get(node.id);
    return {
      id: node.id,
      type: node.type,
      position: { ...node.position },
      data: { ...node.data },
      selected: local?.selected,
      measured: local?.measured,
      width: local?.width,
      height: local?.height,
    };
  });
  const edges = options.incoming.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  }));
  return { nodes, edges };
}

export function createEdgeId(
  source: string,
  sourceHandle: string | undefined,
  target: string,
  targetHandle: string | undefined,
): string {
  return `e:${source}:${sourceHandle ?? ""}:${target}:${targetHandle ?? ""}`;
}

/** Selection is canvas chrome, not graph IR — skip `onChange` for select-only diffs. */
export function nodeChangesMutateGraph(
  changes: ReadonlyArray<{ type: string }>,
): boolean {
  return changes.some((change) => change.type !== "select");
}

type PositionChange = {
  type: string;
  id?: string;
  position?: { x: number; y: number };
};

/** Keep the locked axis on the node's current layout position (BT sibling reorder). */
export function lockNodeDragAxis<T extends PositionChange>(
  changes: readonly T[],
  nodes: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
  axis: "x" | "y" | undefined,
): T[] {
  if (!axis) return [...changes];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return changes.map((change) => {
    if (change.type !== "position" || !change.id || !change.position) return change;
    const current = byId.get(change.id);
    if (!current) return change;
    return {
      ...change,
      position:
        axis === "x"
          ? { x: change.position.x, y: current.position.y }
          : { x: current.position.x, y: change.position.y },
    };
  });
}
