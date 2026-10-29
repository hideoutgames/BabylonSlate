/** A square tile of the shadow atlas, in texels from its top-left corner. */
export interface ShadowAtlasTile {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

type Node = { x: number; y: number; size: number; tile: ShadowAtlasTile | null; children: Node[] | null };

/**
 * Packs square power-of-two tiles into a square atlas as a quadtree: a tile takes the first free node of its size,
 * splitting larger free nodes into quarters, and freeing it merges quarters that are all free again. Tiles never
 * move, so a tile's shadow keeps its texels while others come and go.
 */
export class ShadowAtlasAllocator {
  readonly edge: number;
  private readonly root: Node;

  constructor(edge: number) {
    if (!isPowerOfTwo(edge)) throw new Error(`The shadow atlas edge must be a power of two, not ${edge}.`);
    this.edge = edge;
    this.root = { x: 0, y: 0, size: edge, tile: null, children: null };
  }

  /** A free tile `size` texels wide (a power of two, at most the atlas's edge), or null when none is free. */
  allocate(size: number): ShadowAtlasTile | null {
    if (!isPowerOfTwo(size) || size > this.edge) return null;
    return take(this.root, size);
  }

  free(tile: ShadowAtlasTile): void {
    release(this.root, tile);
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function take(node: Node, size: number): ShadowAtlasTile | null {
  if (node.tile || node.size < size) return null;
  if (node.size === size) {
    if (node.children) return null;
    node.tile = { x: node.x, y: node.y, size };
    return node.tile;
  }
  if (!node.children) {
    const half = node.size / 2;
    node.children = [[0, 0], [half, 0], [0, half], [half, half]].map(([dx, dy]) =>
      ({ x: node.x + dx!, y: node.y + dy!, size: half, tile: null, children: null }));
  }
  for (const child of node.children) {
    const tile = take(child, size);
    if (tile) return tile;
  }
  return null;
}

/** Frees `tile` under `node`; true when `node` is wholly free afterwards. */
function release(node: Node, tile: ShadowAtlasTile): boolean {
  if (node.tile === tile) {
    node.tile = null;
    return true;
  }
  if (!node.children || tile.x < node.x || tile.y < node.y || tile.x >= node.x + node.size || tile.y >= node.y + node.size) return false;
  for (const child of node.children) release(child, tile);
  if (node.children.every((child) => !child.tile && !child.children)) node.children = null;
  return !node.children && !node.tile;
}
