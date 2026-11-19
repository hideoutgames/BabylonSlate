import {
  formatLayoutBoxesOverlap,
  type FormatLayoutBox,
  type FormatLayoutNode,
  type GraphFormatLayout,
} from "./format-layout";

/** Horizontal room between neighbouring subtrees, at their closest level. */
export const FORMAT_TREE_SIBLING_GAP = 48;
/** Vertical room between one level's tallest node and the next level. */
export const FORMAT_TREE_LEVEL_GAP = 96;

export type FormatTreeLayoutOptions = {
  /** The tree's root. Without one, the top-most node that has children and no parent. */
  rootId?: string;
  /**
   * Sibling order, which a tree may execute in. Without one, siblings keep their current left-to-right order (then
   * id). Format places siblings left to right in this order, so an order read back from X never changes.
   */
  compareSiblings?: (a: FormatLayoutNode, b: FormatLayoutNode) => number;
  siblingGap?: number;
  levelGap?: number;
};

type Contour = {
  /** Left and right extents per level, bottom level first (so a parent's level is a push); values + `shift`. */
  lo: number[];
  hi: number[];
  shift: number;
};

function byPositionThenId(a: FormatLayoutNode, b: FormatLayoutNode): number {
  return a.position.x - b.position.x || a.position.y - b.position.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A tidy top-down tree: each parent centred over the span of its children, siblings in order left to right, and
 * subtrees packed as close as their outlines allow (Reingold-Tilford contours, real node sizes, O(n)). Every level's
 * nodes share a top edge; a level is as tall as its tallest node, plus the level gap.
 *
 * Scope: with nothing selected, or the root selected, the whole tree under the root; otherwise the subtree under each
 * selected node that has no selected ancestor. Each laid-out subtree's top node keeps its position. Nodes outside
 * the laid-out subtrees (orphans, the rest of the tree) never move: when a subtree would land on one, its nodes below
 * its top node move down together, only as far as needed to clear it. Malformed data (several parents, cycles)
 * cannot hang it: a node is laid out under the first parent the walk reaches.
 */
export function formatTreeLayout(
  input: Parameters<GraphFormatLayout>[0],
  options: FormatTreeLayoutOptions = {},
): ReturnType<GraphFormatLayout> {
  const siblingGap = options.siblingGap ?? FORMAT_TREE_SIBLING_GAP;
  const levelGap = options.levelGap ?? FORMAT_TREE_LEVEL_GAP;
  const compare = options.compareSiblings ?? byPositionThenId;
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, FormatLayoutNode[]>();
  const hasParent = new Set<string>();
  for (const edge of input.edges) {
    if (edge.source === edge.target) continue;
    const child = byId.get(edge.target);
    if (!child || !byId.has(edge.source)) continue;
    const list = childrenOf.get(edge.source);
    if (list) {
      if (!list.includes(child)) list.push(child);
    } else childrenOf.set(edge.source, [child]);
    hasParent.add(edge.target);
  }
  for (const list of childrenOf.values()) list.sort(compare);

  const treeRoot = treeRootOf(input.nodes, byId, childrenOf, hasParent, options.rootId);
  const selected = input.selectedIds.filter((id) => byId.has(id));
  let roots: FormatLayoutNode[];
  if (selected.length === 0 || (treeRoot && selected.includes(treeRoot.id))) {
    roots = treeRoot ? [treeRoot] : [];
  } else {
    const parentOf = new Map<string, string>();
    for (const [parent, list] of childrenOf) {
      for (const child of list) if (!parentOf.has(child.id)) parentOf.set(child.id, parent);
    }
    const chosen = new Set(selected);
    roots = selected
      .filter((id) => !hasSelectedAncestor(id, parentOf, chosen))
      .map((id) => byId.get(id)!)
      .sort(byPositionThenId);
  }

  const claimed = new Set<string>();
  const subtrees = roots.map((root) => claimSubtree(root, childrenOf, claimed));
  const placed = new Map<string, { x: number; y: number }>();
  // Laid-out subtrees must clear what stays: every node outside them, then each subtree placed before.
  const obstacles: FormatLayoutBox[] = input.nodes
    .filter((node) => !claimed.has(node.id))
    .map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height }));
  for (const subtree of subtrees) {
    const positions = placeSubtree(subtree, siblingGap, levelGap);
    const below: FormatLayoutBox[] = [];
    for (const node of subtree.order.slice(1)) {
      const position = positions.get(node.id)!;
      below.push({ x: position.x, y: position.y, width: node.width, height: node.height });
    }
    const dy = clearanceShift(below, obstacles, siblingGap);
    for (const node of subtree.order) {
      const position = positions.get(node.id)!;
      const y = node === subtree.order[0] ? position.y : position.y + dy;
      placed.set(node.id, { x: position.x, y });
      obstacles.push({ x: position.x, y, width: node.width, height: node.height });
    }
  }
  return [...placed].map(([id, position]) => ({ id, position }));
}

function treeRootOf(
  nodes: readonly FormatLayoutNode[],
  byId: ReadonlyMap<string, FormatLayoutNode>,
  childrenOf: ReadonlyMap<string, FormatLayoutNode[]>,
  hasParent: ReadonlySet<string>,
  rootId: string | undefined,
): FormatLayoutNode | undefined {
  if (rootId !== undefined && byId.has(rootId)) return byId.get(rootId);
  const topMost = (list: FormatLayoutNode[]) =>
    [...list].sort((a, b) => a.position.y - b.position.y || byPositionThenId(a, b))[0];
  return (
    topMost(nodes.filter((node) => !hasParent.has(node.id) && childrenOf.has(node.id))) ??
    topMost([...nodes])
  );
}

function hasSelectedAncestor(id: string, parentOf: ReadonlyMap<string, string>, chosen: ReadonlySet<string>): boolean {
  const seen = new Set<string>([id]);
  let current = parentOf.get(id);
  while (current !== undefined && !seen.has(current)) {
    if (chosen.has(current)) return true;
    seen.add(current);
    current = parentOf.get(current);
  }
  return false;
}

type Subtree = {
  /** Pre-order: the top node first, every parent before its children. */
  order: FormatLayoutNode[];
  kids: Map<string, FormatLayoutNode[]>;
  depth: Map<string, number>;
};

/** The subtree under `root`, each node under the first parent the walk reaches (so a cycle ends). */
function claimSubtree(
  root: FormatLayoutNode,
  childrenOf: ReadonlyMap<string, FormatLayoutNode[]>,
  claimed: Set<string>,
): Subtree {
  const subtree: Subtree = { order: [], kids: new Map(), depth: new Map() };
  if (claimed.has(root.id)) return subtree;
  claimed.add(root.id);
  subtree.depth.set(root.id, 0);
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    subtree.order.push(node);
    const kids: FormatLayoutNode[] = [];
    for (const child of childrenOf.get(node.id) ?? []) {
      if (claimed.has(child.id)) continue;
      claimed.add(child.id);
      subtree.depth.set(child.id, subtree.depth.get(node.id)! + 1);
      kids.push(child);
    }
    subtree.kids.set(node.id, kids);
    for (let index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]!);
  }
  return subtree;
}

function placeSubtree(
  subtree: Subtree,
  siblingGap: number,
  levelGap: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const root = subtree.order[0];
  if (!root) return positions;
  const levelHeights: number[] = [];
  for (const node of subtree.order) {
    const depth = subtree.depth.get(node.id)!;
    levelHeights[depth] = Math.max(levelHeights[depth] ?? 0, node.height);
  }
  const levelTops = [0];
  for (let depth = 1; depth < levelHeights.length; depth += 1) {
    levelTops[depth] = levelTops[depth - 1]! + levelHeights[depth - 1]! + levelGap;
  }

  // Bottom-up: each child's centre relative to its parent's, and each subtree's contour in its top node's frame.
  const relative = new Map<string, number>();
  const contours = new Map<string, Contour>();
  for (let index = subtree.order.length - 1; index >= 0; index -= 1) {
    const node = subtree.order[index]!;
    const kids = subtree.kids.get(node.id)!;
    let contour: Contour;
    if (kids.length === 0) {
      contour = { lo: [], hi: [], shift: 0 };
    } else {
      const offsets: number[] = [0];
      let acc = contours.get(kids[0]!.id)!;
      for (let k = 1; k < kids.length; k += 1) {
        const next = contours.get(kids[k]!.id)!;
        const shared = Math.min(acc.lo.length, next.lo.length);
        let offset = -Infinity;
        for (let d = 0; d < shared; d += 1) {
          const a = acc.hi[acc.hi.length - 1 - d]! + acc.shift;
          const b = next.lo[next.lo.length - 1 - d]! + next.shift;
          offset = Math.max(offset, a - b + siblingGap);
        }
        offsets.push(offset);
        acc = mergeContours(acc, next, offset, shared);
      }
      const first = kids[0]!;
      const last = kids[kids.length - 1]!;
      const middle = (offsets[0]! - first.width / 2 + offsets[kids.length - 1]! + last.width / 2) / 2;
      kids.forEach((kid, k) => relative.set(kid.id, offsets[k]! - middle));
      acc.shift -= middle;
      contour = acc;
    }
    contour.lo.push(-node.width / 2 - contour.shift);
    contour.hi.push(node.width / 2 - contour.shift);
    contours.set(node.id, contour);
    for (const kid of kids) contours.delete(kid.id);
  }

  const centres = new Map<string, number>([[root.id, root.position.x + root.width / 2]]);
  for (const node of subtree.order) {
    const centre = centres.get(node.id)!;
    for (const kid of subtree.kids.get(node.id)!) centres.set(kid.id, centre + relative.get(kid.id)!);
    positions.set(
      node.id,
      node === root
        ? { x: node.position.x, y: node.position.y }
        : {
            x: Math.round(centre - node.width / 2),
            y: Math.round(root.position.y + levelTops[subtree.depth.get(node.id)!]!),
          },
    );
  }
  return positions;
}

/**
 * The contour of `left` and `right` side by side, `right` moved by `offset`. Only the levels both have are written,
 * into whichever contour is deeper, so the merges of a whole tree cost O(n).
 */
function mergeContours(left: Contour, right: Contour, offset: number, shared: number): Contour {
  if (left.lo.length >= right.lo.length) {
    for (let d = 0; d < shared; d += 1) {
      const leftIndex = left.hi.length - 1 - d;
      left.hi[leftIndex] = right.hi[right.hi.length - 1 - d]! + right.shift + offset - left.shift;
    }
    return left;
  }
  right.shift += offset;
  for (let d = 0; d < shared; d += 1) {
    const rightIndex = right.lo.length - 1 - d;
    right.lo[rightIndex] = left.lo[left.lo.length - 1 - d]! + left.shift - right.shift;
  }
  return right;
}

/** How far `boxes` must move down together to clear every obstacle by `clearance`. */
function clearanceShift(
  boxes: readonly FormatLayoutBox[],
  obstacles: readonly FormatLayoutBox[],
  clearance: number,
): number {
  let dy = 0;
  // Each round clears at least one obstacle for good (moving down never brings an obstacle above back), so it ends.
  for (let round = 0; round <= obstacles.length; round += 1) {
    let needed = dy;
    for (const box of boxes) {
      const moved = { ...box, y: box.y + dy };
      for (const obstacle of obstacles) {
        if (formatLayoutBoxesOverlap(moved, obstacle, clearance)) {
          needed = Math.max(needed, obstacle.y + obstacle.height + clearance - box.y);
        }
      }
    }
    if (needed === dy) return dy;
    dy = needed;
  }
  return dy;
}
