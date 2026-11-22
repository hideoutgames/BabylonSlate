import { addPinOf, isRerouteNodeData } from "./graph-types";

export const GRAPH_VIRTUALIZE_OVERSCAN_PX = 400;
/** A Reroute knot at Large Pins 1 with a mouse (`.graph-reroute-knot` in graph-editor.css). */
export const REROUTE_KNOT_SIZE = { width: 80, height: 35 } as const;
/** Blueprint node shells are at least `min-w-80` wide. */
export const GRAPH_NODE_FALLBACK_WIDTH = 320;
/** An unmeasured node whose pins are unknown (a host node type without `__pins`). */
export const GRAPH_NODE_FALLBACK_HEIGHT = 120;
// Pin node geometry at Large Pins 1, as measured in the editor (`PinNode` in graph-nodes.tsx): a 42px title bar,
// then the pin list (`py-1` plus the 1px border) holding one 44px row per pin pair, so a pure node with one row is 96
// tall with its handles 69 below its top, and each further row adds 44.
/** The title bar, where header pins sit. */
export const GRAPH_NODE_TITLE_HEIGHT = 42;
/** From a node's top edge to the top of its first pin row. */
export const GRAPH_PIN_LIST_TOP = 47;
/** From the bottom of the last pin row (or the Add Pin row) to the node's bottom edge. */
export const GRAPH_PIN_LIST_BOTTOM = 5;
/** One pin row (`PinRow`, `min-h-[var(--touch-target,44px)]`); the Add Pin control takes one more. */
export const GRAPH_PIN_ROW_HEIGHT = 44;

/** From an unmeasured node's top edge to the centre of pin row `row` (0 is the first), where its handles sit. */
export function graphPinRowCenterY(row: number): number {
  return GRAPH_PIN_LIST_TOP + row * GRAPH_PIN_ROW_HEIGHT + GRAPH_PIN_ROW_HEIGHT / 2;
}

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
 * output pins share rows, so the longer of the two columns sets the height
 * (header pins sit in the title bar); an Add Pin control (`__addPin`) is one
 * more row below them. Unknown pins take the fallback height.
 */
export function estimateGraphNodeSize(
  pins?: ReadonlyArray<{ direction?: string; placement?: string }>,
  data?: Record<string, unknown>,
): { width: number; height: number } {
  if (isRerouteNodeData(data)) return { ...REROUTE_KNOT_SIZE };
  if (!pins) return { width: GRAPH_NODE_FALLBACK_WIDTH, height: GRAPH_NODE_FALLBACK_HEIGHT };
  let inputs = 0;
  let outputs = 0;
  for (const pin of pins) {
    if (pin.placement === "header") continue;
    if (pin.direction === "out") outputs += 1;
    else inputs += 1;
  }
  const rows = Math.max(inputs, outputs) + (addPinOf(data) ? 1 : 0);
  return {
    width: GRAPH_NODE_FALLBACK_WIDTH,
    height: GRAPH_PIN_LIST_TOP + rows * GRAPH_PIN_ROW_HEIGHT + GRAPH_PIN_LIST_BOTTOM,
  };
}

function nodePins(
  node: GraphVirtualizeNode,
): ReadonlyArray<{ direction?: string }> | undefined {
  const pins = (node.data as { __pins?: unknown } | undefined)?.__pins;
  return Array.isArray(pins) ? pins : undefined;
}

/** Measured size, else the pin-row estimate for a node that never mounted. */
export function graphNodeSize(
  node: GraphVirtualizeNode,
): { width: number; height: number } {
  const width = node.measured?.width || node.width;
  const height = node.measured?.height || node.height;
  if (width && height) return { width, height };
  const estimate = estimateGraphNodeSize(nodePins(node), node.data as Record<string, unknown> | undefined);
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
    const { width, height } = graphNodeSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * How far the culling box may move in world space, along each axis, before any
 * node's test against it can change: an open interval per axis. Inside it, the
 * same viewport size and zoom over the same nodes, wires and kept ids mounts
 * exactly what the last cull mounted.
 */
export type GraphCullHold = { minDx: number; maxDx: number; minDy: number; maxDy: number };

/**
 * One axis of a node against the culling box moved by d along it: the node's
 * `low`..`high` overlaps `boxLow + d`..`boxHigh + d` while `high >= boxLow + d`
 * (d <= `reachesLow`) and `low <= boxHigh + d` (d >= `reachesHigh`).
 */
function axisReach(low: number, high: number, boxLow: number, boxHigh: number) {
  const reachesLow = high - boxLow;
  const reachesHigh = low - boxHigh;
  return { reachesLow, reachesHigh, overlaps: reachesLow >= 0 && reachesHigh <= 0 };
}

/** Narrows `range` to the moves that keep an overlapping axis overlapping. */
function keepOverlap(range: [number, number], axis: ReturnType<typeof axisReach>): void {
  range[0] = Math.max(range[0], axis.reachesHigh);
  range[1] = Math.min(range[1], axis.reachesLow);
}

/** Narrows `range` to the moves that keep a separated axis separated. */
function keepApart(range: [number, number], axis: ReturnType<typeof axisReach>): void {
  if (axis.reachesLow < 0) range[0] = Math.max(range[0], axis.reachesLow);
  else range[1] = Math.min(range[1], axis.reachesHigh);
}

/** How far a separated axis can move before it overlaps. */
function apartBy(axis: ReturnType<typeof axisReach>): number {
  return axis.reachesLow < 0 ? -axis.reachesLow : axis.reachesHigh;
}

/**
 * Narrows the hold so the node's mounted state survives the move: a mounted
 * node keeps both axes overlapping; an unmounted one keeps one separated axis
 * separated (the farther one, when both are), which is enough to stay out.
 */
function narrowHold(holdX: [number, number], holdY: [number, number], x: ReturnType<typeof axisReach>, y: ReturnType<typeof axisReach>): void {
  if (x.overlaps && y.overlaps) {
    keepOverlap(holdX, x);
    keepOverlap(holdY, y);
  } else if (!x.overlaps && (y.overlaps || apartBy(x) >= apartBy(y))) {
    keepApart(holdX, x);
  } else {
    keepApart(holdY, y);
  }
}

/**
 * Mount nodes near the flow viewport (plus overscan) and edges that touch
 * them. `keepIds` (focus / search / selection) and both ends of a selected
 * edge stay mounted even when off-screen so `fitView`, Copy / Delete, and
 * the next selection change still resolve them. A 0×0 viewport (jsdom /
 * first paint) returns the full lists. `hold` says how far a pan may move
 * the viewport before the result can change (`cullStillHolds`).
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
): { nodes: N[]; edges: E[]; hold?: GraphCullHold } {
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
  const holdX: [number, number] = [-Infinity, Infinity];
  const holdY: [number, number] = [-Infinity, Infinity];
  for (const node of nodes) {
    const { width, height } = graphNodeSize(node);
    const x = axisReach(node.position.x, node.position.x + width, minX, maxX);
    const y = axisReach(node.position.y, node.position.y + height, minY, maxY);
    narrowHold(holdX, holdY, x, y);
    if (x.overlaps && y.overlaps) nearIds.add(node.id);
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
    hold: { minDx: holdX[0], maxDx: holdX[1], minDy: holdY[0], maxDy: holdY[1] },
  };
}

/** Margin, in world units, that keeps float rounding of the box from deciding a node on its edge. */
const HOLD_EPSILON = 1e-6;

/**
 * Whether culling the same nodes, wires and kept ids at `next` mounts exactly
 * what the cull at `previous` (whose `hold` it returned) mounted: the size and
 * zoom are unchanged and the pan stays strictly inside the hold, so the
 * rescan can be skipped.
 */
export function cullStillHolds(
  previous: GraphVirtualizeViewport,
  next: GraphVirtualizeViewport,
  hold: GraphCullHold | undefined,
): boolean {
  if (!hold || next.zoom !== previous.zoom || next.width !== previous.width || next.height !== previous.height) return false;
  // The box's world origin is -viewport / zoom, so a pan moves it by the opposite of the viewport's change.
  const dx = (previous.x - next.x) / next.zoom;
  const dy = (previous.y - next.y) / next.zoom;
  return (
    dx > hold.minDx + HOLD_EPSILON && dx < hold.maxDx - HOLD_EPSILON &&
    dy > hold.minDy + HOLD_EPSILON && dy < hold.maxDy - HOLD_EPSILON
  );
}
