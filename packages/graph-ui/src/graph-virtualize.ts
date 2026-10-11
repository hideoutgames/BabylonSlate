export const GRAPH_VIRTUALIZE_OVERSCAN_PX = 400;
/** Blueprint node shells are at least `min-w-80` wide. */
export const GRAPH_NODE_FALLBACK_WIDTH = 320;
export const GRAPH_NODE_FALLBACK_HEIGHT = 120;
/** Title bar plus the pin list padding above the first 44px pin row. */
const GRAPH_NODE_CHROME_HEIGHT = 50;
const GRAPH_PIN_ROW_HEIGHT = 44;

export type GraphVirtualizeViewport = {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
};

export type GraphVirtualizeNode = {
  id: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
  data?: unknown;
};

export type GraphVirtualizeEdge = {
  id?: string;
  source: string;
  target: string;
  selected?: boolean;
};

/**
 * Size of a node that has never been measured (never mounted). Input and
 * output pins share rows, so the longer of the two columns sets the height.
 */
export function estimateGraphNodeSize(
  pins?: ReadonlyArray<{ direction?: string }>,
): { width: number; height: number } {
  let inputs = 0;
  let outputs = 0;
  for (const pin of pins ?? []) {
    if (pin.direction === "out") outputs += 1;
    else inputs += 1;
  }
  return {
    width: GRAPH_NODE_FALLBACK_WIDTH,
    height: Math.max(
      GRAPH_NODE_FALLBACK_HEIGHT,
      GRAPH_NODE_CHROME_HEIGHT + Math.max(inputs, outputs) * GRAPH_PIN_ROW_HEIGHT,
    ),
  };
}

function nodePins(
  node: GraphVirtualizeNode,
): ReadonlyArray<{ direction?: string }> | undefined {
  const pins = (node.data as { __pins?: unknown } | undefined)?.__pins;
  return Array.isArray(pins) ? pins : undefined;
}

function nodeSize(node: GraphVirtualizeNode): { width: number; height: number } {
  const width = node.measured?.width || node.width;
  const height = node.measured?.height || node.height;
  if (width && height) return { width, height };
  const estimate = estimateGraphNodeSize(nodePins(node));
  return { width: width || estimate.width, height: height || estimate.height };
}

/** World-space box around every node; unmeasured nodes use their estimated size. */
export function graphNodesBounds(
  nodes: readonly GraphVirtualizeNode[],
): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const { width, height } = nodeSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function nodeIntersectsWorld(
  node: GraphVirtualizeNode,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const { width, height } = nodeSize(node);
  return (
    node.position.x + width >= minX &&
    node.position.x <= maxX &&
    node.position.y + height >= minY &&
    node.position.y <= maxY
  );
}

/**
 * Mount nodes near the flow viewport (plus overscan) and edges that touch
 * them. `keepIds` (focus / search / selection) and both ends of a selected
 * edge stay mounted even when off-screen so `fitView`, Copy / Delete, and
 * the next selection change still resolve them. A 0×0 viewport (jsdom /
 * first paint) returns the full lists.
 */
export function selectVisibleGraphElements<
  N extends GraphVirtualizeNode,
  E extends GraphVirtualizeEdge,
>(
  nodes: readonly N[],
  edges: readonly E[],
  viewport: GraphVirtualizeViewport,
  overscan = GRAPH_VIRTUALIZE_OVERSCAN_PX,
  keepIds: readonly string[] = [],
): { nodes: N[]; edges: E[] } {
  if (viewport.width <= 0 || viewport.height <= 0 || viewport.zoom <= 0) {
    return { nodes: [...nodes], edges: [...edges] };
  }
  const zoom = viewport.zoom;
  const minX = (-viewport.x - overscan) / zoom;
  const minY = (-viewport.y - overscan) / zoom;
  const maxX = (-viewport.x + viewport.width + overscan) / zoom;
  const maxY = (-viewport.y + viewport.height + overscan) / zoom;
  const nearIds = new Set<string>(keepIds);
  for (const edge of edges) {
    if (!edge.selected) continue;
    nearIds.add(edge.source);
    nearIds.add(edge.target);
  }
  for (const node of nodes) {
    if (nodeIntersectsWorld(node, minX, minY, maxX, maxY)) {
      nearIds.add(node.id);
    }
  }
  const mountedIds = new Set(nearIds);
  for (const edge of edges) {
    if (nearIds.has(edge.source)) mountedIds.add(edge.target);
    if (nearIds.has(edge.target)) mountedIds.add(edge.source);
  }
  return {
    nodes: nodes.filter((node) => mountedIds.has(node.id)),
    edges: edges.filter(
      (edge) => mountedIds.has(edge.source) && mountedIds.has(edge.target),
    ),
  };
}
