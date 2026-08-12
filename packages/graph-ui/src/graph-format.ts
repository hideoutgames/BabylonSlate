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

function layoutThenChain(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  startId: string,
): FormatNode[] {
  const start = nodes.find((node) => node.id === startId);
  if (!start) return nodes;
  const layers = thenChainLayers(startId, nodes, edges);
  const positions = new Map<string, { x: number; y: number }>();
  let x = start.position.x;
  for (const layer of layers) {
    let y = start.position.y;
    let layerWidth = 0;
    for (const id of layer) {
      const node = nodes.find((entry) => entry.id === id);
      if (!node) continue;
      const size = nodeSize(node);
      positions.set(id, { x, y });
      y += size.height + FORMAT_GAP_Y;
      layerWidth = Math.max(layerWidth, size.width);
    }
    x += layerWidth + FORMAT_GAP_X;
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
