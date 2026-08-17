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

type ChainWalk = "exec" | "data";

function isImpureNode(
  node: FormatNode | undefined,
  nodeId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): boolean {
  if (node?.pins?.some((pin) => pin.kind === "exec")) return true;
  if (node?.pins && node.pins.length > 0) return false;
  return edges.some(
    (edge) => edge.source === nodeId && isExecOutEdge(edge, nodes),
  );
}

function chainWalkKind(
  startId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): ChainWalk {
  const start = nodes.find((node) => node.id === startId);
  return isImpureNode(start, startId, nodes, edges) ? "exec" : "data";
}

function chainSuccessors(
  nodeId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
  walk: ChainWalk,
): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.source !== nodeId) continue;
    const include =
      walk === "exec"
        ? isExecOutEdge(edge, nodes)
        : isDataOutEdge(edge, nodes);
    if (!include || seen.has(edge.target)) continue;
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
  const walk = chainWalkKind(startId, nodes, edges);
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    for (const target of chainSuccessors(id, nodes, edges, walk)) {
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
  const walk = chainWalkKind(startId, nodes, edges);
  const visited = new Set<string>([startId]);
  const layers: string[][] = [];
  let current = [startId];
  while (current.length > 0) {
    layers.push(current);
    const next: string[] = [];
    for (const id of current) {
      for (const target of chainSuccessors(id, nodes, edges, walk)) {
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

function hangingSubtreeSize(
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
  let kidsWidth = 0;
  let kidsHeight = 0;
  for (let i = 0; i < kids.length; i++) {
    const kid = hangingSubtreeSize(kids[i]!, byId, children, cache);
    kidsWidth = Math.max(kidsWidth, kid.width);
    if (i > 0) kidsHeight += FORMAT_GAP_Y;
    kidsHeight += kid.height;
  }
  const measured = {
    width: size.width + FORMAT_GAP_X + kidsWidth,
    height: size.height + FORMAT_GAP_Y + kidsHeight,
  };
  cache.set(nodeId, measured);
  return measured;
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
  const node = byId.get(nodeId);
  if (!node) return;
  const size = nodeSize(node);
  const kids = children.get(nodeId) ?? [];
  let childY = y + size.height + FORMAT_GAP_Y;
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
    childY += hangingSubtreeSize(kidId, byId, children, cache).height + FORMAT_GAP_Y;
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
  const walk = chainWalkKind(startId, nodes, edges);
  const layers = thenChainLayers(startId, nodes, edges);
  const chainOrder = layers.flat();
  const chainIds = new Set(chainOrder);
  const children = claimDataInputTrees(chainIds, chainOrder, nodes, edges);
  const cache = new Map<string, { width: number; height: number }>();
  const positions = new Map<string, { x: number; y: number }>();
  const startSize = nodeSize(start);
  let x = start.position.x;
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex]!;
    let layerWidth = 0;
    for (const id of layer) {
      const node = byId.get(id);
      if (node) layerWidth = Math.max(layerWidth, nodeSize(node).width);
    }
    let y =
      walk === "data"
        ? start.position.y + layerIndex * (startSize.height + FORMAT_GAP_Y)
        : start.position.y;
    for (const id of layer) {
      const node = byId.get(id);
      if (!node) continue;
      placeNodeWithInputs(id, x, y, byId, children, cache, positions);
      y += nodeSize(node).height + FORMAT_GAP_Y;
    }
    x += layerWidth + FORMAT_GAP_X;
  }
  return withPositions(nodes, positions);
}

function formatMemberIds(
  startId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): Set<string> {
  const layers = thenChainLayers(startId, nodes, edges);
  const chainOrder = layers.flat();
  const children = claimDataInputTrees(
    new Set(chainOrder),
    chainOrder,
    nodes,
    edges,
  );
  const ids = new Set(chainOrder);
  for (const [parent, kids] of children) {
    ids.add(parent);
    for (const kid of kids) ids.add(kid);
  }
  return ids;
}

function formatChainRoots(
  selectedIds: readonly string[],
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): string[] {
  const selected = selectedIds.filter((id) =>
    nodes.some((node) => node.id === id),
  );
  const contained = new Set<string>();
  for (const id of selected) {
    const chain = collectThenChain(id, nodes, edges);
    for (const other of selected) {
      if (other !== id && chain.includes(other)) contained.add(other);
    }
  }
  return selected
    .filter((id) => !contained.has(id))
    .sort((a, b) => {
      const nodeA = nodes.find((node) => node.id === a);
      const nodeB = nodes.find((node) => node.id === b);
      const ay = nodeA?.position.y ?? 0;
      const by = nodeB?.position.y ?? 0;
      if (ay !== by) return ay - by;
      const ax = nodeA?.position.x ?? 0;
      const bx = nodeB?.position.x ?? 0;
      if (ax !== bx) return ax - bx;
      return a.localeCompare(b);
    });
}

function nodeBox(node: FormatNode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const size = nodeSize(node);
  return {
    x: node.position.x,
    y: node.position.y,
    width: size.width,
    height: size.height,
  };
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function translateIds(
  nodes: FormatNode[],
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): FormatNode[] {
  if (dx === 0 && dy === 0) return nodes;
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    if (!ids.has(node.id)) continue;
    positions.set(node.id, {
      x: node.position.x + dx,
      y: node.position.y + dy,
    });
  }
  return withPositions(nodes, positions);
}

function lowerOverlappingNode(a: FormatNode, b: FormatNode): FormatNode {
  if (a.position.y !== b.position.y) {
    return a.position.y > b.position.y ? a : b;
  }
  if (a.position.x !== b.position.x) {
    return a.position.x > b.position.x ? a : b;
  }
  return a.id.localeCompare(b.id) > 0 ? a : b;
}

function nudgeOverlappingMembers(
  nodes: FormatNode[],
  ids: ReadonlySet<string>,
): FormatNode[] {
  if (ids.size < 2) return nodes;
  let current = nodes;
  for (let pass = 0; pass < 32; pass++) {
    const members = current.filter((node) => ids.has(node.id));
    let extra = 0;
    let movingId: string | undefined;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!;
        const b = members[j]!;
        if (!boxesOverlap(nodeBox(a), nodeBox(b))) continue;
        const lower = lowerOverlappingNode(a, b);
        const upper = lower.id === a.id ? b : a;
        const upperBox = nodeBox(upper);
        const needed =
          upperBox.y + upperBox.height + FORMAT_GAP_Y - lower.position.y;
        if (needed > extra) {
          extra = needed;
          movingId = lower.id;
        }
      }
    }
    if (extra <= 0 || !movingId) break;
    current = translateIds(current, new Set([movingId]), 0, extra);
  }
  return current;
}

function shiftChainClearOf(
  nodes: FormatNode[],
  movingIds: ReadonlySet<string>,
  blockerIds: ReadonlySet<string>,
): FormatNode[] {
  if (movingIds.size === 0 || blockerIds.size === 0) return nodes;
  let current = nodes;
  for (let pass = 0; pass < 32; pass++) {
    let extra = 0;
    const moving = current.filter((node) => movingIds.has(node.id));
    const blockers = current.filter((node) => blockerIds.has(node.id));
    for (const mover of moving) {
      const moverBox = nodeBox(mover);
      for (const blocker of blockers) {
        const blockerBox = nodeBox(blocker);
        if (!boxesOverlap(moverBox, blockerBox)) continue;
        extra = Math.max(
          extra,
          blockerBox.y + blockerBox.height + FORMAT_GAP_Y - moverBox.y,
        );
      }
    }
    if (extra <= 0) break;
    current = translateIds(current, movingIds, 0, extra);
  }
  return current;
}

export function formatGraphNodes(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  selectedIds: readonly string[],
): FormatNode[] {
  if (selectedIds.length === 0) return nodes;
  const roots = formatChainRoots(selectedIds, nodes, edges);
  if (roots.length === 0) return nodes;
  let current = nodes;
  const placed = new Set<string>();
  for (const root of roots) {
    current = layoutThenChain(current, edges, root);
    const members = formatMemberIds(root, current, edges);
    current = nudgeOverlappingMembers(current, members);
    current = shiftChainClearOf(current, members, placed);
    current = nudgeOverlappingMembers(current, members);
    for (const id of members) placed.add(id);
  }
  return current;
}
