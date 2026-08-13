import type { SerializedPin } from "./graph-types";
import {
  MARQUEE_FALLBACK_HEIGHT,
  MARQUEE_FALLBACK_WIDTH,
} from "./graph-marquee";

export const FORMAT_GAP_X = 80;
export const FORMAT_GAP_Y = 40;

export type FormatNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  pins?: SerializedPin[];
};

export type FormatEdge = {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
};

function nodeSize(node: FormatNode): { width: number; height: number } {
  return {
    width: node.width ?? node.measured?.width ?? MARQUEE_FALLBACK_WIDTH,
    height: node.height ?? node.measured?.height ?? MARQUEE_FALLBACK_HEIGHT,
  };
}

function sourcePin(
  nodes: readonly FormatNode[],
  edge: FormatEdge,
): SerializedPin | undefined {
  const source = nodes.find((node) => node.id === edge.source);
  return source?.pins?.find((pin) => pin.id === edge.sourceHandle);
}

function isExecOutEdge(
  edge: FormatEdge,
  nodes: readonly FormatNode[],
): boolean {
  const pin = sourcePin(nodes, edge);
  if (pin) return pin.kind === "exec" && pin.direction === "out";
  const handle = edge.sourceHandle ?? "";
  return (
    handle === "execOut" ||
    handle === "then" ||
    handle === "true" ||
    handle === "false" ||
    handle.startsWith("then")
  );
}

function isDataOutEdge(
  edge: FormatEdge,
  nodes: readonly FormatNode[],
): boolean {
  const pin = sourcePin(nodes, edge);
  if (pin) return pin.kind === "data" && pin.direction === "out";
  return Boolean(edge.sourceHandle) && !isExecOutEdge(edge, nodes);
}

function isRightwardEdge(
  edge: FormatEdge,
  nodes: readonly FormatNode[],
): boolean {
  return isExecOutEdge(edge, nodes) || isDataOutEdge(edge, nodes);
}

function thenSuccessors(
  nodeId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.source !== nodeId || !isRightwardEdge(edge, nodes)) continue;
    if (seen.has(edge.target)) continue;
    seen.add(edge.target);
    targets.push(edge.target);
  }
  return targets;
}

export function collectThenChain(
  startId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): string[] {
  if (!nodes.some((node) => node.id === startId)) return [];
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    for (const target of thenSuccessors(id, nodes, edges)) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return order;
}

function thenChainLayers(
  startId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): string[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([startId]);
  const layers: string[][] = [];
  let current = [startId];
  while (current.length > 0) {
    layers.push(current);
    const next: string[] = [];
    for (const id of current) {
      for (const target of thenSuccessors(id, nodes, edges)) {
        if (visited.has(target) || !byId.has(target)) continue;
        visited.add(target);
        next.push(target);
      }
    }
    next.sort((a, b) => {
      const ay = byId.get(a)?.position.y ?? 0;
      const by = byId.get(b)?.position.y ?? 0;
      if (ay !== by) return ay - by;
      return a.localeCompare(b);
    });
    current = next;
  }
  return layers;
}

function hasIncomingExec(
  nodeId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): boolean {
  return edges.some(
    (edge) => edge.target === nodeId && isExecOutEdge(edge, nodes),
  );
}

function dataInPinOrder(node: FormatNode | undefined): string[] {
  return (
    node?.pins
      ?.filter((pin) => pin.kind === "data" && pin.direction === "in")
      .map((pin) => pin.id) ?? []
  );
}

function dataInSources(
  nodeId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pinOrder = dataInPinOrder(byId.get(nodeId));
  const best = new Map<string, { pinIndex: number; y: number }>();
  for (const edge of edges) {
    if (edge.target !== nodeId || !isDataOutEdge(edge, nodes)) continue;
    const source = byId.get(edge.source);
    if (!source) continue;
    const pinIndex = edge.targetHandle
      ? pinOrder.indexOf(edge.targetHandle)
      : -1;
    const resolved = pinIndex === -1 ? Number.MAX_SAFE_INTEGER : pinIndex;
    const prev = best.get(edge.source);
    if (!prev || resolved < prev.pinIndex) {
      best.set(edge.source, { pinIndex: resolved, y: source.position.y });
    }
  }
  return [...best.entries()]
    .sort((a, b) => {
      if (a[1].pinIndex !== b[1].pinIndex) return a[1].pinIndex - b[1].pinIndex;
      if (a[1].y !== b[1].y) return a[1].y - b[1].y;
      return a[0].localeCompare(b[0]);
    })
    .map(([id]) => id);
}

function claimDataInputTrees(
  chainIds: ReadonlySet<string>,
  chainOrder: readonly string[],
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  const claimed = new Set<string>();

  const claimFrom = (nodeId: string, walking: Set<string>): void => {
    if (walking.has(nodeId)) return;
    walking.add(nodeId);
    const owned: string[] = [];
    for (const sourceId of dataInSources(nodeId, nodes, edges)) {
      if (chainIds.has(sourceId) || claimed.has(sourceId)) continue;
      if (hasIncomingExec(sourceId, nodes, edges)) continue;
      claimed.add(sourceId);
      owned.push(sourceId);
      claimFrom(sourceId, walking);
    }
    children.set(nodeId, owned);
  };

  for (const id of chainOrder) {
    claimFrom(id, new Set());
  }
  return children;
}

function withPositions(
  nodes: FormatNode[],
  positions: Map<string, { x: number; y: number }>,
): FormatNode[] {
  return nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position) return node;
    if (position.x === node.position.x && position.y === node.position.y) {
      return node;
    }
    return { ...node, position };
  });
}

function subtreeSize(
  nodeId: string,
  byId: Map<string, FormatNode>,
  children: Map<string, string[]>,
  cache: Map<string, { width: number; height: number }>,
): { width: number; height: number } {
  const cached = cache.get(nodeId);
  if (cached) return cached;
  const node = byId.get(nodeId);
  if (!node) {
    const empty = { width: 0, height: 0 };
    cache.set(nodeId, empty);
    return empty;
  }
  const size = nodeSize(node);
  const kids = children.get(nodeId) ?? [];
  if (kids.length === 0) {
    cache.set(nodeId, size);
    return size;
  }
  let colWidth = 0;
  let colHeight = 0;
  for (let i = 0; i < kids.length; i++) {
    const kid = subtreeSize(kids[i]!, byId, children, cache);
    colWidth = Math.max(colWidth, kid.width);
    if (i > 0) colHeight += FORMAT_GAP_Y;
    colHeight += kid.height;
  }
  const measured = {
    width: colWidth + FORMAT_GAP_X + size.width,
    height: Math.max(size.height, colHeight),
  };
  cache.set(nodeId, measured);
  return measured;
}

function leftTreeWidth(
  nodeId: string,
  byId: Map<string, FormatNode>,
  children: Map<string, string[]>,
  cache: Map<string, { width: number; height: number }>,
): number {
  const kids = children.get(nodeId) ?? [];
  if (kids.length === 0) return 0;
  return Math.max(
    ...kids.map((kid) => subtreeSize(kid, byId, children, cache).width),
  );
}

function stackedHeight(
  nodeId: string,
  byId: Map<string, FormatNode>,
  children: Map<string, string[]>,
  cache: Map<string, { width: number; height: number }>,
): number {
  const node = byId.get(nodeId);
  if (!node) return 0;
  const size = nodeSize(node);
  const kids = children.get(nodeId) ?? [];
  if (kids.length === 0) return size.height;
  let colHeight = 0;
  for (let i = 0; i < kids.length; i++) {
    if (i > 0) colHeight += FORMAT_GAP_Y;
    colHeight += subtreeSize(kids[i]!, byId, children, cache).height;
  }
  return Math.max(size.height, colHeight);
}

function placeNodeWithInputs(
  nodeId: string,
  x: number,
  y: number,
  byId: Map<string, FormatNode>,
  children: Map<string, string[]>,
  cache: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
): void {
  positions.set(nodeId, { x, y });
  const kids = children.get(nodeId) ?? [];
  let childY = y;
  for (const kidId of kids) {
    const kid = byId.get(kidId);
    if (!kid) continue;
    const kidSize = nodeSize(kid);
    placeNodeWithInputs(
      kidId,
      x - FORMAT_GAP_X - kidSize.width,
      childY,
      byId,
      children,
      cache,
      positions,
    );
    childY += subtreeSize(kidId, byId, children, cache).height + FORMAT_GAP_Y;
  }
}

function layoutThenChain(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  startId: string,
): FormatNode[] {
  const start = nodes.find((node) => node.id === startId);
  if (!start) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const layers = thenChainLayers(startId, nodes, edges);
  const chainOrder = layers.flat();
  const chainIds = new Set(chainOrder);
  const children = claimDataInputTrees(chainIds, chainOrder, nodes, edges);
  const cache = new Map<string, { width: number; height: number }>();
  const positions = new Map<string, { x: number; y: number }>();
  let x = start.position.x;
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex]!;
    let maxLeft = 0;
    let layerWidth = 0;
    for (const id of layer) {
      maxLeft = Math.max(maxLeft, leftTreeWidth(id, byId, children, cache));
      const node = byId.get(id);
      if (node) layerWidth = Math.max(layerWidth, nodeSize(node).width);
    }
    const consumerX =
      layerIndex > 0 && maxLeft > 0 ? x + maxLeft + FORMAT_GAP_X : x;
    let y = start.position.y;
    for (const id of layer) {
      placeNodeWithInputs(id, consumerX, y, byId, children, cache, positions);
      y += stackedHeight(id, byId, children, cache) + FORMAT_GAP_Y;
    }
    x = consumerX + layerWidth + FORMAT_GAP_X;
  }
  return withPositions(nodes, positions);
}

function layoutSelectedRow(
  nodes: FormatNode[],
  selectedIds: readonly string[],
): FormatNode[] {
  const selected = selectedIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is FormatNode => Boolean(node))
    .sort((a, b) => {
      if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      return a.position.y - b.position.y;
    });
  if (selected.length === 0) return nodes;
  const originX = Math.min(...selected.map((node) => node.position.x));
  const originY = Math.min(...selected.map((node) => node.position.y));
  const positions = new Map<string, { x: number; y: number }>();
  let x = originX;
  for (const node of selected) {
    positions.set(node.id, { x, y: originY });
    x += nodeSize(node).width + FORMAT_GAP_X;
  }
  return withPositions(nodes, positions);
}

export function formatGraphNodes(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  selectedIds: readonly string[],
): FormatNode[] {
  if (selectedIds.length === 0) return nodes;
  if (selectedIds.length === 1) {
    return layoutThenChain(nodes, edges, selectedIds[0]!);
  }
  return layoutSelectedRow(nodes, selectedIds);
}
