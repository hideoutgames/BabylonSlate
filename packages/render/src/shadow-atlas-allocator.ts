/** A square tile of the shadow atlas: its page (`layer`), and in texels from that page's top-left corner. */
export interface ShadowAtlasTile {
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

type Node = { x: number; y: number; size: number; tile: ShadowAtlasTile | null; children: Node[] | null };

/**
 * Packs square power-of-two tiles into the pages of a square atlas: `edge` texels split into square pages of
 * `pageEdge` (the layers of one depth texture array), each packed as a quadtree. A tile takes the first free node of its
 * size, splitting larger free nodes into quarters, and freeing it merges quarters that are all free again. Tiles never
 * move, so a tile's shadow keeps its texels while others come and go, and a tile never crosses a page.
 */
export class ShadowAtlasAllocator {
  readonly edge: number;
  readonly pageEdge: number;
  private readonly roots: Node[];

  constructor(edge: number, pageEdge = edge) {
    if (!isPowerOfTwo(edge)) throw new Error(`The shadow atlas edge must be a power of two, not ${edge}.`);
    if (!isPowerOfTwo(pageEdge) || pageEdge > edge) throw new Error(`A shadow atlas page must be a power of two within its ${edge} edge, not ${pageEdge}.`);
    this.edge = edge;
    this.pageEdge = pageEdge;
    this.roots = Array.from({ length: (edge / pageEdge) ** 2 }, () => ({ x: 0, y: 0, size: pageEdge, tile: null, children: null }));
  }

  /** How many pages the atlas holds: its depth texture's layers. */
  get pages(): number {
    return this.roots.length;
  }

  /**
   * A free tile `size` texels wide (a power of two, at most a page's edge), or null when none is free: the first free
   * node of its size, pages in order. With four pages (`shadowAtlasPageEdge`) that is where one quadtree over the whole
   * edge, its quarters in the pages' order, would place it.
   */
  allocate(size: number): ShadowAtlasTile | null {
    if (!isPowerOfTwo(size) || size > this.pageEdge) return null;
    for (let layer = 0; layer < this.roots.length; layer++) {
      const tile = take(this.roots[layer]!, layer, size);
      if (tile) return tile;
    }
    return null;
  }

  free(tile: ShadowAtlasTile): void {
    const root = this.roots[tile.layer];
    if (root) release(root, tile);
  }

  /** No tile is allocated. */
  get empty(): boolean {
    return this.roots.every((root) => !root.tile && !root.children);
  }

  /** Whether every tile allocated in page `layer` is one of `tiles`. */
  holdsOnly(layer: number, tiles: ReadonlySet<ShadowAtlasTile>): boolean {
    const root = this.roots[layer];
    return !!root && only(root, tiles);
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function take(node: Node, layer: number, size: number): ShadowAtlasTile | null {
  if (node.tile || node.size < size) return null;
  if (node.size === size) {
    if (node.children) return null;
    node.tile = { layer, x: node.x, y: node.y, size };
    return node.tile;
  }
  if (!node.children) {
    const half = node.size / 2;
    node.children = [[0, 0], [half, 0], [0, half], [half, half]].map(([dx, dy]) =>
      ({ x: node.x + dx!, y: node.y + dy!, size: half, tile: null, children: null }));
  }
  for (const child of node.children) {
    const tile = take(child, layer, size);
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

function only(node: Node, tiles: ReadonlySet<ShadowAtlasTile>): boolean {
  if (node.tile) return tiles.has(node.tile);
  return !node.children || node.children.every((child) => only(child, tiles));
}
