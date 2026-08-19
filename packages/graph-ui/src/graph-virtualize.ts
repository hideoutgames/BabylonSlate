export const GRAPH_VIRTUALIZE_OVERSCAN_PX = 400;
export const GRAPH_NODE_FALLBACK_WIDTH = 320;
export const GRAPH_NODE_FALLBACK_HEIGHT = 120;

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
};

export type GraphVirtualizeEdge = {
  id?: string;
  source: string;
  target: string;
};

function nodeSize(node: GraphVirtualizeNode): { width: number; height: number } {
  return {
    width:
      node.measured?.width || node.width || GRAPH_NODE_FALLBACK_WIDTH,
    height:
      node.measured?.height || node.height || GRAPH_NODE_FALLBACK_HEIGHT,
  };
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
 * them. `keepIds` (focus / search / selection) stay mounted even when
 * off-screen so `fitView` and Copy / Delete still resolve them. A 0×0
 * viewport (jsdom / first paint) returns the full lists.
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
