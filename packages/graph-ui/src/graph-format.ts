import type { SerializedPin } from "./graph-types";
import {
  MARQUEE_FALLBACK_HEIGHT,
  MARQUEE_FALLBACK_WIDTH,
} from "./graph-marquee";

export const FORMAT_GAP_X = 80;
export const FORMAT_GAP_Y = 40;

// Small parameter trees retain their compact diagonal shape. Taller trees use
// horizontal rows so another pure operation does not add another full row.
const HELIX_MAX_HEIGHT = 320;

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

type Position = { x: number; y: number };
type Box = Position & { width: number; height: number };
type ChainWalk = "exec" | "data";
type GraphIndex = {
  byId: Map<string, FormatNode>;
  outgoing: Record<ChainWalk, Map<string, string[]>>;
  dataInputs: Map<string, string[]>;
  incomingExec: Set<string>;
};

function nodeSize(node: FormatNode): { width: number; height: number } {
  return {
    width: node.width ?? node.measured?.width ?? MARQUEE_FALLBACK_WIDTH,
    height: node.height ?? node.measured?.height ?? MARQUEE_FALLBACK_HEIGHT,
  };
}

function compareNodes(
  graph: GraphIndex,
  a: string,
  b: string,
  positions?: ReadonlyMap<string, Position>,
): number {
  const left = positions?.get(a) ?? graph.byId.get(a)!.position;
  const right = positions?.get(b) ?? graph.byId.get(b)!.position;
  return left.y - right.y || left.x - right.x || a.localeCompare(b);
}

function indexGraph(
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): GraphIndex {
  const graph: GraphIndex = {
    byId: new Map(nodes.map((node) => [node.id, node])),
    outgoing: { exec: new Map(), data: new Map() },
    dataInputs: new Map(),
    incomingExec: new Set(),
  };
  const incomingData = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    const source = graph.byId.get(edge.source);
    const target = graph.byId.get(edge.target);
    if (!source || !target) continue;
    const pin = source.pins?.find((entry) => entry.id === edge.sourceHandle);
    const handle = edge.sourceHandle ?? "";
    const fallbackExec =
      handle === "execOut" ||
      handle === "then" ||
      handle === "true" ||
      handle === "false" ||
      handle.startsWith("then");
    const kind = pin
      ? pin.direction === "out"
        ? pin.kind
        : undefined
      : fallbackExec
        ? "exec"
        : handle
          ? "data"
          : undefined;
    if (kind !== "exec" && kind !== "data") continue;
    const targets = graph.outgoing[kind].get(source.id) ?? [];
    if (!targets.includes(target.id)) targets.push(target.id);
    graph.outgoing[kind].set(source.id, targets);
    if (kind === "exec") {
      graph.incomingExec.add(target.id);
    } else {
      const pins =
        target.pins?.filter(
          (entry) => entry.kind === "data" && entry.direction === "in",
        ) ?? [];
      const pinIndex = pins.findIndex(
        (entry) => entry.id === edge.targetHandle,
      );
      const order = pinIndex < 0 ? Number.MAX_SAFE_INTEGER : pinIndex;
      const sources = incomingData.get(target.id) ?? new Map<string, number>();
      sources.set(source.id, Math.min(sources.get(source.id) ?? order, order));
      incomingData.set(target.id, sources);
    }
  }
  for (const [id, sources] of incomingData) {
    graph.dataInputs.set(
      id,
      [...sources.keys()].sort(
        (a, b) =>
          sources.get(a)! - sources.get(b)! || compareNodes(graph, a, b),
      ),
    );
  }
  return graph;
}

function chainWalkKind(startId: string, graph: GraphIndex): ChainWalk {
  const node = graph.byId.get(startId);
  if (node?.pins?.length) {
    return node.pins.some((pin) => pin.kind === "exec") ? "exec" : "data";
  }
  return graph.outgoing.exec.has(startId) ? "exec" : "data";
}

function collectChain(startId: string, graph: GraphIndex): string[] {
  if (!graph.byId.has(startId)) return [];
  const outgoing = graph.outgoing[chainWalkKind(startId, graph)];
  const order = [startId];
  const visited = new Set(order);
  for (let index = 0; index < order.length; index++) {
    for (const target of outgoing.get(order[index]!) ?? []) {
      if (visited.has(target)) continue;
      visited.add(target);
      order.push(target);
    }
  }
  return order;
}

export function collectThenChain(
  startId: string,
  nodes: readonly FormatNode[],
  edges: readonly FormatEdge[],
): string[] {
  return collectChain(startId, indexGraph(nodes, edges));
}

type LayoutTree = {
  roots: string[];
  order: string[];
  children: Map<string, string[]>;
  ranks: Map<string, number>;
};

function layoutTree(
  startIds: readonly string[],
  successors: (id: string) => readonly string[],
): LayoutTree {
  const roots: string[] = [];
  const order: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const children = new Map<string, string[]>();
  const forward = new Map<string, string[]>();
  const finished: string[] = [];
  for (const startId of startIds) {
    if (visited.has(startId)) continue;
    roots.push(startId);
    order.push(startId);
    visited.add(startId);
    active.add(startId);
    const stack = [{ id: startId, targets: successors(startId), next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const target = frame.targets[frame.next++];
      if (target === undefined) {
        active.delete(frame.id);
        finished.push(frame.id);
        stack.pop();
        continue;
      }
      // A loop's return wire must remain a return wire. Ignore only DFS back
      // edges when computing ranks; retain every other predecessor of a merge.
      if (active.has(target)) continue;
      const links = forward.get(frame.id) ?? [];
      links.push(target);
      forward.set(frame.id, links);
      if (visited.has(target)) continue;
      const owned = children.get(frame.id) ?? [];
      owned.push(target);
      children.set(frame.id, owned);
      visited.add(target);
      active.add(target);
      order.push(target);
      stack.push({ id: target, targets: successors(target), next: 0 });
    }
  }
  const ranks = new Map<string, number>(roots.map((id) => [id, 0]));
  for (let index = finished.length - 1; index >= 0; index--) {
    const id = finished[index]!;
    for (const target of forward.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, ranks.get(id)! + 1));
    }
  }
  return { roots, order, children, ranks };
}

function treeHeights(
  tree: LayoutTree,
  graph: GraphIndex,
  diagonal: boolean,
): Map<string, number> {
  const heights = new Map<string, number>();
  for (let index = tree.order.length - 1; index >= 0; index--) {
    const id = tree.order[index]!;
    const height = nodeSize(graph.byId.get(id)!).height;
    const children = tree.children.get(id) ?? [];
    const childHeight =
      children.reduce(
        (total, child) => total + heights.get(child)! + FORMAT_GAP_Y,
        0,
      ) - (children.length > 0 ? FORMAT_GAP_Y : 0);
    heights.set(
      id,
      diagonal && children.length > 0
        ? height + FORMAT_GAP_Y + childHeight
        : Math.max(height, childHeight),
    );
  }
  return heights;
}

function treeRows(
  tree: LayoutTree,
  graph: GraphIndex,
  diagonal: boolean,
): Map<string, number> {
  const heights = treeHeights(tree, graph, diagonal);
  const rows = new Map<string, number>();
  let rootY = 0;
  for (const root of tree.roots) {
    rows.set(root, rootY);
    rootY += heights.get(root)! + FORMAT_GAP_Y;
  }
  for (const id of tree.order) {
    let y =
      rows.get(id)! +
      (diagonal ? nodeSize(graph.byId.get(id)!).height + FORMAT_GAP_Y : 0);
    for (const child of tree.children.get(id) ?? []) {
      rows.set(child, y);
      y += heights.get(child)! + FORMAT_GAP_Y;
    }
  }
  return rows;
}

function claimDataInputs(
  chain: LayoutTree,
  graph: GraphIndex,
  previouslyPlaced: ReadonlySet<string>,
): Map<string, Set<string>> {
  const claimed = new Set([...chain.order, ...previouslyPlaced]);
  const owners = new Map<string, Set<string>>();
  // Prefer the earliest execution consumer, even if DFS visited its merge
  // before a shorter branch. Shared parameters are moved exactly once.
  const chainOrder = [...chain.order].sort(
    (a, b) => chain.ranks.get(a)! - chain.ranks.get(b)!,
  );
  for (const owner of chainOrder) {
    const inputs = new Set<string>();
    const stack = [...(graph.dataInputs.get(owner) ?? [])].reverse();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (claimed.has(id) || graph.incomingExec.has(id)) continue;
      claimed.add(id);
      inputs.add(id);
      stack.push(...[...(graph.dataInputs.get(id) ?? [])].reverse());
    }
    owners.set(owner, inputs);
  }
  return owners;
}

type ParameterBlock = { positions: Map<string, Position>; left: number };

function parameterBlock(
  owner: string,
  members: ReadonlySet<string>,
  graph: GraphIndex,
): ParameterBlock {
  const tree = layoutTree([owner], (id) =>
    (graph.dataInputs.get(id) ?? []).filter((source) => members.has(source)),
  );
  const diagonalHeight = treeHeights(tree, graph, true).get(owner)!;
  const diagonal = diagonalHeight <= HELIX_MAX_HEIGHT;
  const rows = treeRows(tree, graph, diagonal);
  // Inputs always begin below their execution consumer, including when the
  // rest of a large parameter block switches to left-side rows.
  if (!diagonal) {
    const top = nodeSize(graph.byId.get(owner)!).height + FORMAT_GAP_Y;
    for (const id of members) rows.set(id, rows.get(id)! + top);
  }
  const widths: number[] = [];
  for (const id of members) {
    const rank = tree.ranks.get(id)!;
    widths[rank] = Math.max(
      widths[rank] ?? 0,
      nodeSize(graph.byId.get(id)!).width,
    );
  }
  const columns = [0];
  for (let rank = 1; rank < widths.length; rank++) {
    columns[rank] = columns[rank - 1]! - FORMAT_GAP_X - widths[rank]!;
  }
  const positions = new Map<string, Position>();
  let left = 0;
  for (const id of members) {
    const rank = tree.ranks.get(id)!;
    const x =
      columns[rank]! + widths[rank]! - nodeSize(graph.byId.get(id)!).width;
    positions.set(id, { x, y: rows.get(id)! });
    if (!diagonal) left = Math.max(left, -x);
  }
  return { positions, left };
}

function boxAt(graph: GraphIndex, id: string, position: Position): Box {
  return { ...position, ...nodeSize(graph.byId.get(id)!) };
}

function clearVerticalOffset(
  moving: readonly Box[],
  blockers: readonly Box[],
): number {
  // Each horizontally intersecting pair excludes one interval of Y offsets.
  // Sweeping these intervals gives a clear position without a pass limit and
  // moves entire trees together instead of tearing individual nodes off them.
  const intervals: { from: number; to: number }[] = [];
  for (const mover of moving) {
    for (const blocker of blockers) {
      if (
        mover.x >= blocker.x + blocker.width ||
        mover.x + mover.width <= blocker.x
      ) {
        continue;
      }
      const to = blocker.y + blocker.height - mover.y;
      if (to <= 0) continue;
      intervals.push({ from: blocker.y - mover.y - mover.height, to });
    }
  }
  intervals.sort((a, b) => a.from - b.from);
  let offset = 0;
  for (const interval of intervals) {
    if (interval.from < offset && interval.to > offset)
      offset = interval.to + FORMAT_GAP_Y;
  }
  return offset;
}

function layoutChain(
  startIds: readonly string[],
  graph: GraphIndex,
  placed: Map<string, Position>,
): void {
  const startId = startIds[0]!;
  const start = graph.byId.get(startId)!;
  const origin = placed.get(startId) ?? start.position;
  const walk = chainWalkKind(startId, graph);
  const tree = layoutTree(startIds, (id) =>
    [...(graph.outgoing[walk].get(id) ?? [])].sort(
      (a, b) =>
        Number(!placed.has(a)) - Number(!placed.has(b)) ||
        compareNodes(graph, a, b, placed),
    ),
  );
  const owners = claimDataInputs(tree, graph, new Set(placed.keys()));
  const blocks = new Map<string, ParameterBlock>();
  for (const [owner, members] of owners) {
    blocks.set(owner, parameterBlock(owner, members, graph));
  }
  const widths: number[] = [];
  const inputWidths: number[] = [];
  const fixedColumns: number[] = [];
  for (const id of tree.order) {
    const rank = tree.ranks.get(id)!;
    widths[rank] = Math.max(
      widths[rank] ?? 0,
      nodeSize(graph.byId.get(id)!).width,
    );
    inputWidths[rank] = Math.max(inputWidths[rank] ?? 0, blocks.get(id)!.left);
    const fixed = placed.get(id);
    if (fixed)
      fixedColumns[rank] = Math.max(fixedColumns[rank] ?? -Infinity, fixed.x);
  }
  const columns = [origin.x];
  for (let rank = 1; rank < widths.length; rank++) {
    columns[rank] = Math.max(
      columns[rank - 1]! +
        widths[rank - 1]! +
        FORMAT_GAP_X +
        inputWidths[rank]!,
      fixedColumns[rank] ?? -Infinity,
    );
  }
  const diagonal =
    walk === "data" &&
    treeHeights(tree, graph, true).get(startId)! <= HELIX_MAX_HEIGHT;
  const rows = treeRows(tree, graph, diagonal);
  const positions = new Map<string, Position>();
  const blockers: Box[] = [];
  for (const id of tree.order) {
    const position = placed.get(id) ?? {
      x: columns[tree.ranks.get(id)!]!,
      y: origin.y + rows.get(id)!,
    };
    positions.set(id, position);
    blockers.push(boxAt(graph, id, position));
  }
  const chainOrder = [...tree.order].sort(
    (a, b) => tree.ranks.get(a)! - tree.ranks.get(b)!,
  );
  for (const owner of chainOrder) {
    const anchor = positions.get(owner)!;
    const inputs = [...blocks.get(owner)!.positions].map(([id, relative]) => ({
      id,
      position: { x: anchor.x + relative.x, y: anchor.y + relative.y },
    }));
    const offset = clearVerticalOffset(
      inputs.map(({ id, position }) => boxAt(graph, id, position)),
      blockers,
    );
    for (const { id, position } of inputs) {
      position.y += offset;
      positions.set(id, position);
      blockers.push(boxAt(graph, id, position));
    }
  }
  const moving = [...positions].filter(([id]) => !placed.has(id));
  const offset = clearVerticalOffset(
    moving.map(([id, position]) => boxAt(graph, id, position)),
    [...placed].map(([id, position]) => boxAt(graph, id, position)),
  );
  for (const [id, position] of moving) {
    placed.set(id, { x: position.x, y: position.y + offset });
  }
}

function formatChainRoots(
  selectedIds: readonly string[],
  graph: GraphIndex,
): string[] {
  const selected = [...new Set(selectedIds)]
    .filter((id) => graph.byId.has(id))
    .sort((a, b) => {
      const left = graph.byId.get(a)!;
      const right = graph.byId.get(b)!;
      return (
        Number(chainWalkKind(a, graph) === "data") -
          Number(chainWalkKind(b, graph) === "data") ||
        left.position.y - right.position.y ||
        left.position.x - right.position.x ||
        a.localeCompare(b)
      );
    });
  const chains = new Map(
    selected.map((id) => [id, new Set(collectChain(id, graph))]),
  );
  return selected.filter(
    (id, index) =>
      !selected.some(
        (other, otherIndex) =>
          other !== id &&
          chainWalkKind(other, graph) === chainWalkKind(id, graph) &&
          chains.get(other)!.has(id) &&
          (!chains.get(id)!.has(other) || otherIndex < index),
      ),
  );
}

export function formatGraphNodes(
  nodes: FormatNode[],
  edges: readonly FormatEdge[],
  selectedIds: readonly string[],
): FormatNode[] {
  if (selectedIds.length === 0) return nodes;
  const graph = indexGraph(nodes, edges);
  const roots = formatChainRoots(selectedIds, graph);
  if (roots.length === 0) return nodes;
  const positions = new Map<string, Position>();
  const remaining = new Set(roots);
  const chains = new Map(
    roots.map((root) => [root, new Set(collectChain(root, graph))]),
  );
  for (const root of roots) {
    if (
      !remaining.delete(root) ||
      [...chains.get(root)!].every((id) => positions.has(id))
    )
      continue;
    const group = [root];
    for (let index = 0; index < group.length; index++) {
      const chain = chains.get(group[index]!)!;
      for (const other of remaining) {
        if (chainWalkKind(other, graph) !== chainWalkKind(root, graph))
          continue;
        if (![...chains.get(other)!].some((id) => chain.has(id))) continue;
        remaining.delete(other);
        group.push(other);
      }
    }
    // Selected roots which meet at a join share ranks and lanes. Disconnected
    // roots remain separate blocks, anchored at their own original positions.
    layoutChain(group, graph, positions);
  }
  return nodes.map((node) => {
    const position = positions.get(node.id);
    if (
      !position ||
      (position.x === node.position.x && position.y === node.position.y)
    )
      return node;
    return { ...node, position };
  });
}
