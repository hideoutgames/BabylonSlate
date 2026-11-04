/** Tilemap selections: copy, move, paste and erase blocks of cells; pure and Babylon-free. */

import type { TilesetPayload } from "./tileset-payload";
import {
  chunkCoordForTile,
  emptyChunkTiles,
  localIndex,
  setTiles,
  TILEMAP_CELL_LIMIT,
  tileInBounds,
  tilemapCellKey,
  tilemapLayerPaintedExtent,
  tilemapTileIdentity,
  encodeTileGid,
  type TilemapCellRect,
  type TilemapChunk,
  type TilemapPayload,
  type TilemapTilesetRef,
  type TileWrite,
} from "./tilemap-payload";
import { refreshStaleTilemapTerrains, resolveTilemapTerrainAround } from "./tilemap-terrain";

/** One copied layer: its tiles as chunks of the block's own cells, cell (0, 0) the block's bottom-left. */
export interface TilemapClipLayer {
  layerId: string;
  chunks: TilemapChunk[];
}

/**
 * A copied block of cells: what Cut and Copy keep and Paste places. Empty
 * cells are part of the block but never written when it is placed.
 */
export interface TilemapClip {
  /** Cells across and up, empty ones included. */
  width: number;
  height: number;
  /** Chunk size of every layer's chunks. */
  chunkSize: number;
  /** The copied layers, in the map's layer order. */
  layers: TilemapClipLayer[];
  /** The Tileset ranges the GIDs were copied under (`retargetTilemapClip` re-numbers them for another map). */
  tilesets: readonly TilemapTilesetRef[];
  /** Copied from every layer, so it pastes into the same layers; otherwise from one, pasted into the paint layer. */
  allLayers: boolean;
}

/** The cells a map can hold: a bounded map's size from cell (0, 0), an unbounded map's ±`TILEMAP_CELL_LIMIT`. */
export function tilemapCellBounds(map: TilemapPayload): TilemapCellRect {
  if (map.unbounded) return { minX: -TILEMAP_CELL_LIMIT, minY: -TILEMAP_CELL_LIMIT, maxX: TILEMAP_CELL_LIMIT, maxY: TILEMAP_CELL_LIMIT };
  return { minX: 0, minY: 0, maxX: map.width - 1, maxY: map.height - 1 };
}

/** The part of `rect` (corners in any order) inside the map, or `null` when none of it is. */
export function clampTilemapCellRect(map: TilemapPayload, rect: TilemapCellRect): TilemapCellRect | null {
  const box = tilemapCellBounds(map);
  const minX = Math.max(box.minX, Math.min(rect.minX, rect.maxX));
  const maxX = Math.min(box.maxX, Math.max(rect.minX, rect.maxX));
  const minY = Math.max(box.minY, Math.min(rect.minY, rect.maxY));
  const maxY = Math.min(box.maxY, Math.max(rect.minY, rect.maxY));
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

/** `rect` moved by whole cells. */
export function offsetTilemapCellRect(rect: TilemapCellRect, dx: number, dy: number): TilemapCellRect {
  return { minX: rect.minX + dx, minY: rect.minY + dy, maxX: rect.maxX + dx, maxY: rect.maxY + dy };
}

/** The layers a selection acts on: the one named, or every layer for `null`. */
function scopedLayers(map: TilemapPayload, layerId: string | null) {
  return layerId === null ? map.layers : map.layers.filter((layer) => layer.id === layerId);
}

/**
 * **Select All**: the cells the tiles of one layer cover (every layer for
 * `null`), inside the map; `null` when they have none.
 */
export function tilemapSelectionExtent(map: TilemapPayload, layerId: string | null): TilemapCellRect | null {
  let extent: TilemapCellRect | null = null;
  for (const layer of scopedLayers(map, layerId)) {
    const part = tilemapLayerPaintedExtent(layer, map.chunkSize);
    if (!part) continue;
    extent = extent
      ? { minX: Math.min(extent.minX, part.minX), minY: Math.min(extent.minY, part.minY), maxX: Math.max(extent.maxX, part.maxX), maxY: Math.max(extent.maxY, part.maxY) }
      : part;
  }
  return extent ? clampTilemapCellRect(map, extent) : null;
}

/** Collects tiles into chunks of `size` by cell, for a clip's own grid. */
class ChunkBuilder {
  private readonly chunks = new Map<number, TilemapChunk>();
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  set(x: number, y: number, gid: number): void {
    const { cx, cy, lx, ly } = chunkCoordForTile(x, y, this.size);
    const key = tilemapCellKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) this.chunks.set(key, (chunk = { cx, cy, tiles: emptyChunkTiles(this.size) }));
    chunk.tiles[localIndex(lx, ly, this.size)] = gid;
  }

  /** The chunks, bottom row first, left to right. */
  build(): TilemapChunk[] {
    return [...this.chunks.values()].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  }
}

/** Calls `visit` for every non-empty cell of a clip layer, in the block's cells. */
function forEachClipTile(layer: TilemapClipLayer, size: number, visit: (x: number, y: number, gid: number) => void): void {
  for (const chunk of layer.chunks) {
    const x0 = chunk.cx * size;
    const y0 = chunk.cy * size;
    const tiles = chunk.tiles;
    for (let at = 0; at < tiles.length; at++) {
      const gid = tiles[at]!;
      if (gid > 0) visit(x0 + (at % size), y0 + Math.floor(at / size), gid);
    }
  }
}

/** A clip layer's GIDs by block cell, 0 outside the block or on an empty cell. */
function clipLayerReader(layer: TilemapClipLayer, size: number): (x: number, y: number) => number {
  const chunks = new Map<number, readonly number[]>();
  for (const chunk of layer.chunks) chunks.set(tilemapCellKey(chunk.cx, chunk.cy), chunk.tiles);
  return (x, y) => {
    if (x < 0 || y < 0) return 0;
    const { cx, cy, lx, ly } = chunkCoordForTile(x, y, size);
    return chunks.get(tilemapCellKey(cx, cy))?.[localIndex(lx, ly, size)] ?? 0;
  };
}

/**
 * **Copy**: the tiles of `rect` on one layer (every layer for `null`), as a
 * clip whose cell (0, 0) is the rect's bottom-left. Reads only the chunks the
 * rect touches, so its cost follows the painted cells, not the rect's area.
 */
export function copyTilemapCells(map: TilemapPayload, rect: TilemapCellRect, layerId: string | null): TilemapClip {
  const size = Math.max(1, map.chunkSize);
  const width = rect.maxX - rect.minX + 1;
  const height = rect.maxY - rect.minY + 1;
  const layers = scopedLayers(map, layerId).map((layer): TilemapClipLayer => {
    const builder = new ChunkBuilder(size);
    for (const chunk of layer.chunks) {
      const x0 = chunk.cx * size;
      const y0 = chunk.cy * size;
      const minX = Math.max(rect.minX, x0);
      const maxX = Math.min(rect.maxX, x0 + size - 1);
      const minY = Math.max(rect.minY, y0);
      const maxY = Math.min(rect.maxY, y0 + size - 1);
      if (minX > maxX || minY > maxY) continue;
      for (let y = minY; y <= maxY; y++) {
        const row = (y - y0) * size - x0;
        for (let x = minX; x <= maxX; x++) {
          const gid = chunk.tiles[row + x] ?? 0;
          if (gid > 0) builder.set(x - rect.minX, y - rect.minY, gid);
        }
      }
    }
    return { layerId: layer.id, chunks: builder.build() };
  });
  return { width, height, chunkSize: size, layers, tilesets: map.tilesets, allLayers: layerId === null };
}

/** How many non-empty cells a clip holds, over every layer. */
export function tilemapClipTileCount(clip: TilemapClip): number {
  let count = 0;
  for (const layer of clip.layers) for (const chunk of layer.chunks) count += chunkTileCount(chunk.tiles);
  return count;
}

const chunkCounts = new WeakMap<readonly number[], number>();

/** Non-empty cells of one chunk's `tiles`, cached on the array (arrays are never changed in place). */
function chunkTileCount(tiles: readonly number[]): number {
  let count = chunkCounts.get(tiles);
  if (count === undefined) {
    count = 0;
    for (const gid of tiles) if (gid > 0) count++;
    chunkCounts.set(tiles, count);
  }
  return count;
}

/**
 * How many of a clip's tiles a placement with its bottom-left at `origin`
 * would lose past the map's edge (a bounded map's size, an unbounded map's
 * ±`TILEMAP_CELL_LIMIT`). Whole chunks inside or outside count at once, so a
 * drag reads only the chunks the edge crosses.
 */
export function tilemapClipLostTiles(map: TilemapPayload, clip: TilemapClip, origin: { x: number; y: number }): number {
  const box = tilemapCellBounds(map);
  const size = clip.chunkSize;
  let lost = 0;
  for (const layer of clip.layers) {
    for (const chunk of layer.chunks) {
      const left = origin.x + chunk.cx * size;
      const bottom = origin.y + chunk.cy * size;
      const right = left + size - 1;
      const top = bottom + size - 1;
      if (left >= box.minX && right <= box.maxX && bottom >= box.minY && top <= box.maxY) continue;
      if (right < box.minX || left > box.maxX || top < box.minY || bottom > box.maxY) {
        lost += chunkTileCount(chunk.tiles);
        continue;
      }
      chunk.tiles.forEach((gid, at) => {
        if (!(gid > 0)) return;
        const x = left + (at % size);
        const y = bottom + Math.floor(at / size);
        if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) lost++;
      });
    }
  }
  return lost;
}

/**
 * A clip ready to paste into `map`: GIDs re-numbered from the Tilesets they
 * were copied under to the map's (by Tileset; tiles of a Tileset the map does
 * not use are left out), chunks re-cut on the map's chunk size, and layers
 * named for the map: a clip of every layer keeps the layers the map has, one
 * of a single layer goes to `paintLayerId`. Returns `clip` itself when nothing changes.
 */
export function retargetTilemapClip(clip: TilemapClip, map: TilemapPayload, paintLayerId: string): TilemapClip {
  const ids = new Set(map.layers.map((layer) => layer.id));
  const layers = clip.allLayers
    ? clip.layers.filter((layer) => ids.has(layer.layerId))
    : clip.layers.slice(0, 1).filter(() => ids.has(paintLayerId)).map((layer) => (layer.layerId === paintLayerId ? layer : { ...layer, layerId: paintLayerId }));
  const remap = gidRemap(clip.tilesets, map.tilesets);
  const size = Math.max(1, map.chunkSize);
  const sameLayers = layers.length === clip.layers.length && layers.every((layer, at) => layer === clip.layers[at]);
  if (!remap && size === clip.chunkSize) {
    return sameLayers ? clip : { ...clip, layers, tilesets: map.tilesets };
  }
  const rebuilt = layers.map((layer): TilemapClipLayer => {
    const builder = new ChunkBuilder(size);
    forEachClipTile(layer, clip.chunkSize, (x, y, gid) => {
      const next = remap ? remap(gid) : gid;
      if (next > 0) builder.set(x, y, next);
    });
    return { layerId: layer.layerId, chunks: builder.build() };
  });
  return { ...clip, chunkSize: size, layers: rebuilt, tilesets: map.tilesets };
}

/** GID → GID from one Tileset list to another by Tileset guid, or `null` when both number every tile alike. */
function gidRemap(from: readonly TilemapTilesetRef[], to: readonly TilemapTilesetRef[]): ((gid: number) => number) | null {
  const target = new Map(to.map((ref) => [ref.guid, ref]));
  const same = from.length === to.length && from.every((ref) => {
    const other = target.get(ref.guid);
    return other !== undefined && other.firstGid === ref.firstGid && other.tileCount >= ref.tileCount;
  });
  if (same) return null;
  const source = { tilesets: from } as TilemapPayload;
  const cache = new Map<number, number>();
  return (gid) => {
    let next = cache.get(gid);
    if (next === undefined) {
      const identity = tilemapTileIdentity(source, gid);
      const ref = identity ? target.get(identity.guid) : undefined;
      next = identity && ref && identity.localId <= ref.tileCount ? encodeTileGid(ref.firstGid, identity.localId) : 0;
      cache.set(gid, next);
    }
    return next;
  };
}

/**
 * Whether a placed clip cell at map cell (x, y) is surrounded by its own
 * block: it and its 8 neighbours are non-empty cells of the clip that land in
 * the map, so its terrain surroundings moved with it.
 */
function surroundedInClip(map: TilemapPayload, read: (x: number, y: number) => number, origin: { x: number; y: number }) {
  return (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!read(x + dx - origin.x, y + dy - origin.y) || !tileInBounds(map, x + dx, y + dy)) return false;
      }
    }
    return true;
  };
}

/**
 * Write a clip's non-empty cells with its bottom-left at `origin`, each clip
 * layer into the map layer it names (`retargetTilemapClip`), over what is
 * there; empty clip cells leave the map as it is, and cells past the map's
 * edge are cut off. With `tilesets`, the autotile tiles around the written
 * cells re-pick their variants (`resolveTilemapTerrainAround`). Returns `map`
 * itself when nothing changes.
 */
export function placeTilemapClip(
  map: TilemapPayload,
  clip: TilemapClip,
  origin: { x: number; y: number },
  tilesets?: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  const base = tilesets ? refreshStaleTilemapTerrains(map, tilesets) : map;
  let next = base;
  for (const layer of clip.layers) {
    if (!base.layers.some((entry) => entry.id === layer.layerId)) continue;
    const writes: TileWrite[] = [];
    forEachClipTile(layer, clip.chunkSize, (x, y, gid) => writes.push({ x: origin.x + x, y: origin.y + y, id: gid }));
    if (writes.length === 0) continue;
    next = setTiles(next, layer.layerId, writes);
    if (tilesets) {
      const keep = surroundedInClip(base, clipLayerReader(layer, clip.chunkSize), origin);
      next = resolveTilemapTerrainAround(next, { layerId: layer.layerId, cells: writes, keep, tilesets });
    }
  }
  return next === base ? map : next;
}

/**
 * **Delete**: empty the cells of `rect` on one layer (every layer for
 * `null`). With `tilesets`, the autotile tiles around them re-pick their
 * variants. Returns `map` itself when the rect holds no tile.
 */
export function eraseTilemapCells(
  map: TilemapPayload,
  rect: TilemapCellRect,
  layerId: string | null,
  tilesets?: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  const base = tilesets ? refreshStaleTilemapTerrains(map, tilesets) : map;
  const clip = copyTilemapCells(base, rect, layerId);
  let next = base;
  for (const layer of clip.layers) {
    const writes: TileWrite[] = [];
    forEachClipTile(layer, clip.chunkSize, (x, y) => writes.push({ x: rect.minX + x, y: rect.minY + y, id: 0 }));
    if (writes.length === 0) continue;
    next = setTiles(next, layer.layerId, writes);
    if (tilesets) next = resolveTilemapTerrainAround(next, { layerId: layer.layerId, cells: writes, tilesets });
  }
  return next === base ? map : next;
}

/**
 * **Move**: the tiles of `rect` on one layer (every layer for `null`, each
 * keeping its own tiles) moved by `offset` whole cells, in one edit. Moved
 * tiles overwrite what lies at the destination; empty cells of the rect erase
 * nothing there. Tiles moved past the map's edge are cut off. With
 * `tilesets`, the autotile tiles around the vacated cells and around the
 * destination re-pick their variants, while moved tiles whose neighbours all
 * moved with them keep theirs. Returns `map` itself for a zero offset or an
 * empty rect.
 */
export function moveTilemapCells(
  map: TilemapPayload,
  rect: TilemapCellRect,
  layerId: string | null,
  offset: { x: number; y: number },
  tilesets?: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  const dx = Math.trunc(offset.x) || 0;
  const dy = Math.trunc(offset.y) || 0;
  if (dx === 0 && dy === 0) return map;
  const base = tilesets ? refreshStaleTilemapTerrains(map, tilesets) : map;
  const clip = copyTilemapCells(base, rect, layerId);
  const origin = { x: rect.minX + dx, y: rect.minY + dy };
  let next = base;
  for (const layer of clip.layers) {
    const writes: TileWrite[] = [];
    // Vacate first, so a destination overlapping the rect keeps the moved tiles.
    forEachClipTile(layer, clip.chunkSize, (x, y) => writes.push({ x: rect.minX + x, y: rect.minY + y, id: 0 }));
    if (writes.length === 0) continue;
    forEachClipTile(layer, clip.chunkSize, (x, y, gid) => writes.push({ x: origin.x + x, y: origin.y + y, id: gid }));
    next = setTiles(next, layer.layerId, writes);
    if (tilesets) {
      const keep = surroundedInClip(base, clipLayerReader(layer, clip.chunkSize), origin);
      next = resolveTilemapTerrainAround(next, { layerId: layer.layerId, cells: writes, keep, tilesets });
    }
  }
  return next === base ? map : next;
}

/** Merge key of one selection edit, so a drag or a held arrow key is one undo step. */
export function tilemapSelectionMergeKey(operation: string, id: string): string {
  return `tilemap-select:${operation}:${id}`;
}
