import { sortingLayerSortKey } from "@babylonslate/core";
/** Tilemap asset payload: ordered layers of chunked tile ids (engineplan §13.3). */

import {
  tilesetAtlasColumns,
  tilesetAtlasRows,
  type TilesetPayload,
} from "./tileset-payload";

export const DEFAULT_TILEMAP_CHUNK_SIZE = 32;
export const DEFAULT_TILEMAP_WIDTH = 64;
export const DEFAULT_TILEMAP_HEIGHT = 64;

export interface TilemapChunk {
  cx: number;
  cy: number;
  tiles: number[];
}

export interface TilemapLayer {
  id: string;
  name: string;
  visible: boolean;
  collision: boolean;
  sortingLayer: string;
  orderInLayer: number;
  parallax: { x: number; y: number };
  chunks: TilemapChunk[];
}

export interface TilemapTilesetRef {
  guid: string;
  firstGid: number;
  tileCount: number;
}

export interface TileGidHit {
  guid: string;
  localId: number;
  tileset: TilesetPayload;
}

export interface TilemapPayload {
  tilesets: TilemapTilesetRef[];
  tileWidth: number;
  tileHeight: number;
  /** Map size in tiles, +Y up, origin bottom-left. Storage stays sparse chunks. */
  width: number;
  height: number;
  chunkSize: number;
  layers: TilemapLayer[];
}

export function emptyChunkTiles(chunkSize: number): number[] {
  const size = Math.max(1, chunkSize);
  return Array.from({ length: size * size }, () => 0);
}

export function createDefaultTilemapPayload(): TilemapPayload {
  return {
    tilesets: [],
    tileWidth: 16,
    tileHeight: 16,
    width: DEFAULT_TILEMAP_WIDTH,
    height: DEFAULT_TILEMAP_HEIGHT,
    chunkSize: DEFAULT_TILEMAP_CHUNK_SIZE,
    layers: [createTilemapLayer("layer-1", "Ground")],
  };
}

export function createTilemapLayer(id: string, name: string): TilemapLayer {
  return {
    id,
    name,
    visible: true,
    collision: true,
    sortingLayer: "Default",
    orderInLayer: 0,
    parallax: { x: 1, y: 1 },
    chunks: [],
  };
}

export function addTilemapLayer(
  map: TilemapPayload,
  name = "Layer",
): TilemapPayload {
  const used = new Set(map.layers.map((layer) => layer.id));
  let index = map.layers.length + 1;
  let id = `layer-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `layer-${index}`;
  }
  const usedNames = map.layers.map((layer) => layer.name);
  const uniqueName = usedNames.includes(name)
    ? `${name} ${index}`
    : name;
  return {
    ...map,
    layers: [...map.layers, createTilemapLayer(id, uniqueName)],
  };
}

export function reorderTilemapLayers(
  map: TilemapPayload,
  layerIds: readonly string[],
): TilemapPayload {
  const byId = new Map(map.layers.map((layer) => [layer.id, layer]));
  const layers: TilemapLayer[] = [];
  const seen = new Set<string>();
  for (const id of layerIds) {
    const layer = byId.get(id);
    if (!layer || seen.has(id)) continue;
    seen.add(id);
    layers.push(layer);
  }
  if (layers.length === 0) return map;
  return { ...map, layers };
}

export function tilemapTilesetGuids(map: TilemapPayload): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const ref of map.tilesets) {
    if (!ref.guid || seen.has(ref.guid)) continue;
    seen.add(ref.guid);
    guids.push(ref.guid);
  }
  return guids;
}

/** Tiled GID: `firstGid + localId - 1`. Local id 1 is the first atlas cell. */
export function encodeTileGid(firstGid: number, localId: number): number {
  if (localId <= 0 || firstGid <= 0) return 0;
  return firstGid + localId - 1;
}

/** Saved identity does not depend on whether the atlas is available or has shrunk. */
export function tilemapTileIdentity(
  map: TilemapPayload,
  gid: number,
): { guid: string; localId: number } | null {
  if (!Number.isInteger(gid) || gid <= 0) return null;
  let chosen: TilemapTilesetRef | null = null;
  for (const ref of map.tilesets) {
    if (ref.firstGid <= gid && (!chosen || ref.firstGid > chosen.firstGid)) {
      chosen = ref;
    }
  }
  if (!chosen) return null;
  const localId = gid - chosen.firstGid + 1;
  if (localId > chosen.tileCount) return null;
  return { guid: chosen.guid, localId };
}

export function decodeTileGid(
  map: TilemapPayload,
  gid: number,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): TileGidHit | null {
  const identity = tilemapTileIdentity(map, gid);
  if (!identity) return null;
  const tileset = tilesets.get(identity.guid);
  if (!tileset || identity.localId > atlasTileCount(tileset)) return null;
  return { ...identity, tileset };
}

function atlasTileCount(tileset: TilesetPayload): number {
  return tilesetAtlasColumns(tileset) * tilesetAtlasRows(tileset);
}

function highestPaintedGid(map: TilemapPayload): number {
  let highest = 0;
  for (const layer of map.layers) {
    for (const chunk of layer.chunks) {
      for (const gid of chunk.tiles) highest = Math.max(highest, gid);
    }
  }
  return highest;
}

/**
 * Grow map-local reservations without changing painted Tileset/local-tile identity.
 * Apply this working copy with the next authored edit so ranges and cells undo together.
 */
export function reconcileTilemapTilesets(
  map: TilemapPayload,
  knownTilesets: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  const refs = map.tilesets;
  if (refs.length === 0) return map;
  const ordered = [...refs].sort((a, b) => a.firstGid - b.firstGid);
  // Pointer/selection redraws normally keep the same capacities. Scan painted
  // cells only when atlas growth or overlap needs repair.
  if (ordered.every((ref, index) => {
    const atlas = knownTilesets.get(ref.guid);
    return ref.tileCount >= (atlas ? atlasTileCount(atlas) : 0)
      && ref.firstGid + ref.tileCount <= (ordered[index + 1]?.firstGid ?? Infinity);
  })) return map;
  const nextRefs = new Map(ordered.map((ref) => [ref.guid, { ...ref }]));
  let nextFree = highestPaintedGid(map) + 1;
  for (const ref of nextRefs.values()) nextFree = Math.max(nextFree, ref.firstGid + ref.tileCount);
  const unowned = new Set<number>();
  for (const layer of map.layers) {
    for (const chunk of layer.chunks) {
      for (const gid of chunk.tiles) {
        if (gid > 0 && !tilemapTileIdentity(map, gid)) unowned.add(gid);
      }
    }
  }
  for (const original of ordered) {
    const ref = nextRefs.get(original.guid)!;
    const payload = knownTilesets.get(ref.guid);
    const count = Math.max(ref.tileCount, payload ? atlasTileCount(payload) : 0);
    let nextFirst = Infinity;
    for (const other of nextRefs.values()) {
      if (other.firstGid > ref.firstGid) nextFirst = Math.min(nextFirst, other.firstGid);
    }
    const wouldClaimOrphan = [...unowned].some((gid) => gid >= ref.firstGid && gid < ref.firstGid + count);
    if (ref.firstGid + count > nextFirst || wouldClaimOrphan) ref.firstGid = nextFree;
    ref.tileCount = count;
    nextFree = Math.max(nextFree, ref.firstGid + count);
  }
  const tilesets = refs.map((ref) => nextRefs.get(ref.guid)!);
  if (refs.every((ref, index) =>
    ref.firstGid === tilesets[index]!.firstGid && ref.tileCount === tilesets[index]!.tileCount)) return map;
  const relocated = refs.some((ref) => nextRefs.get(ref.guid)!.firstGid !== ref.firstGid);
  const layers = !relocated ? map.layers : map.layers.map((layer) => ({
    ...layer,
    chunks: layer.chunks.map((chunk) => ({
      ...chunk,
      tiles: chunk.tiles.map((gid) => {
        const identity = tilemapTileIdentity(map, gid);
        return identity ? encodeTileGid(nextRefs.get(identity.guid)!.firstGid, identity.localId) : gid;
      }),
    })),
  }));
  return { ...map, tilesets, layers };
}

export function addTilemapTileset(
  map: TilemapPayload,
  guid: string,
  tileset: TilesetPayload,
  knownTilesets?: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  if (!guid) return map;
  if (map.tilesets.some((ref) => ref.guid === guid)) return map;
  const reconciled = reconcileTilemapTilesets(map, knownTilesets ?? new Map());
  const count = Math.max(1, atlasTileCount(tileset));
  const firstGid = nextTilesetFirstGid(reconciled);
  return { ...reconciled, tilesets: [...reconciled.tilesets, { guid, firstGid, tileCount: count }] };
}

export function removeTilemapTileset(
  map: TilemapPayload,
  guid: string,
): TilemapPayload {
  const removed = map.tilesets.find((ref) => ref.guid === guid);
  if (!removed) return map;
  const firstGid = removed.firstGid;
  const nextFirstGid = Math.min(
    ...map.tilesets.filter((ref) => ref.firstGid > firstGid).map((ref) => ref.firstGid),
  );
  const endGid = Math.min(nextFirstGid, firstGid + removed.tileCount);
  const layers = map.layers.map((layer) => ({
    ...layer,
    chunks: layer.chunks.flatMap((chunk) => {
      if (!chunk.tiles.some((gid) => gid >= firstGid && gid < endGid)) return [chunk];
      const tiles = chunk.tiles.map((gid) => gid >= firstGid && gid < endGid ? 0 : gid);
      return tiles.some((gid) => gid > 0) ? [{ ...chunk, tiles }] : [];
    }),
  }));
  return { ...map, layers, tilesets: map.tilesets.filter((ref) => ref.guid !== guid) };
}

function nextTilesetFirstGid(
  map: TilemapPayload,
): number {
  let next = highestPaintedGid(map) + 1;
  for (const ref of map.tilesets) {
    next = Math.max(next, ref.firstGid + ref.tileCount);
  }
  return next;
}

export function normalizeTilemapPayload(value: unknown): TilemapPayload {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const chunkSize = positiveInt(source.chunkSize, DEFAULT_TILEMAP_CHUNK_SIZE);
  const layers = normalizeLayers(source.layers, chunkSize);
  const tilesets = normalizeTilesetRefs(source.tilesets);
  const resolvedLayers =
    layers.length > 0 ? layers : createDefaultTilemapPayload().layers;
  const extent = occupiedTileExtent(resolvedLayers, chunkSize);
  return {
    tilesets,
    tileWidth: positiveInt(source.tileWidth, 16),
    tileHeight: positiveInt(source.tileHeight, 16),
    width: normalizeMapSize(source.width, extent.width),
    height: normalizeMapSize(source.height, extent.height),
    chunkSize,
    layers: resolvedLayers,
  };
}

function normalizeTilesetRefs(value: unknown): TilemapTilesetRef[] {
  const refs: TilemapTilesetRef[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const guid = stringOrNull(row.guid);
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      refs.push({
        guid,
        firstGid: positiveInt(row.firstGid, 1),
        // Every saved range reserves at least one tile; the next edit grows it to the atlas.
        tileCount: Math.max(1, positiveInt(row.tileCount, 1)),
      });
    }
  }
  return refs;
}

/** Local tile index: `(0,0)` is the bottom-left of the chunk, +Y up. */
export function localIndex(lx: number, ly: number, chunkSize: number): number {
  return ly * chunkSize + lx;
}

export function chunkCoordForTile(
  gx: number,
  gy: number,
  chunkSize: number,
): { cx: number; cy: number; lx: number; ly: number } {
  const size = Math.max(1, chunkSize);
  const cx = Math.floor(gx / size);
  const cy = Math.floor(gy / size);
  const lx = posMod(gx, size);
  const ly = posMod(gy, size);
  return { cx, cy, lx, ly };
}

export function tileInBounds(
  map: Pick<TilemapPayload, "width" | "height">,
  gx: number,
  gy: number,
): boolean {
  return gx >= 0 && gy >= 0 && gx < map.width && gy < map.height;
}

export function getTile(
  map: TilemapPayload,
  layerId: string,
  gx: number,
  gy: number,
): number {
  const layer = map.layers.find((entry) => entry.id === layerId);
  if (!layer) return 0;
  const { cx, cy, lx, ly } = chunkCoordForTile(gx, gy, map.chunkSize);
  const chunk = layer.chunks.find((entry) => entry.cx === cx && entry.cy === cy);
  if (!chunk) return 0;
  return chunk.tiles[localIndex(lx, ly, map.chunkSize)] ?? 0;
}

export function setTile(
  map: TilemapPayload,
  layerId: string,
  gx: number,
  gy: number,
  tileId: number,
): TilemapPayload {
  return setTiles(map, layerId, [{ x: gx, y: gy, id: tileId }]);
}

export interface TileWrite {
  x: number;
  y: number;
  id: number;
}

/**
 * Chunk positions of one layer, kept across the `setTiles` calls of a stroke so
 * each call looks up only the chunks it touches instead of re-indexing the layer.
 * It describes one `chunks` array; handing `setTiles` any other array rebuilds it.
 * With `advance` it moves onto each result, for writes that accumulate on the
 * previous one; without it, it keeps describing the map passed in, for writes
 * re-derived from the same base on every call.
 */
export class TilemapChunkIndex {
  private chunks: readonly TilemapChunk[] | null = null;
  private positions = new Map<string, number>();
  private unique = true;
  private readonly advance: boolean;

  constructor(advance = false) {
    this.advance = advance;
  }

  /** Chunk positions by `cx,cy` key, or `null` when two chunks share a key. */
  positionsOf(chunks: readonly TilemapChunk[]): ReadonlyMap<string, number> | null {
    if (this.chunks !== chunks) {
      const positions = new Map<string, number>();
      for (let at = 0; at < chunks.length; at++) {
        positions.set(`${chunks[at]!.cx},${chunks[at]!.cy}`, at);
      }
      this.chunks = chunks;
      this.positions = positions;
      this.unique = positions.size === chunks.length;
    }
    return this.unique ? this.positions : null;
  }

  /** Follow a write that kept every chunk's position and appended `added`. */
  followAppend(next: readonly TilemapChunk[], added: readonly TilemapChunk[]): void {
    if (!this.advance) return;
    for (let i = 0; i < added.length; i++) {
      this.positions.set(`${added[i]!.cx},${added[i]!.cy}`, next.length - added.length + i);
    }
    this.chunks = next;
  }
}

function isOccupied(chunk: TilemapChunk): boolean {
  return chunk.tiles.some((gid) => gid > 0);
}

/** Chunks changed by `writes`, as copies, keyed by `cx,cy` in the order they first changed. */
function editedChunks(
  map: TilemapPayload,
  size: number,
  writes: Iterable<TileWrite>,
  existing: (key: string) => TilemapChunk | undefined,
): Map<string, TilemapChunk> {
  const edited = new Map<string, TilemapChunk>();
  for (const write of writes) {
    if (!tileInBounds(map, write.x, write.y)) continue;
    const id = Number.isInteger(write.id) && write.id > 0 ? write.id : 0;
    const { cx, cy, lx, ly } = chunkCoordForTile(write.x, write.y, size);
    const key = `${cx},${cy}`;
    const index = localIndex(lx, ly, size);
    let chunk = edited.get(key);
    if (!chunk) {
      const current = existing(key);
      if ((current?.tiles[index] ?? 0) === id) continue;
      chunk = { cx, cy, tiles: current ? [...current.tiles] : emptyChunkTiles(size) };
      edited.set(key, chunk);
    }
    chunk.tiles[index] = id;
  }
  return edited;
}

/**
 * Write many cells, copying each touched chunk once. Cells outside the map are
 * skipped. Storage stays sparse: erasing never allocates a chunk, and a chunk
 * left with no tiles is dropped. Returns `map` itself when nothing changed.
 *
 * A `TilemapChunkIndex` shared by the calls of one stroke keeps each call's
 * lookups proportional to the chunks it touches; the result is the same without it.
 */
export function setTiles(
  map: TilemapPayload,
  layerId: string,
  writes: Iterable<TileWrite>,
  index?: TilemapChunkIndex,
): TilemapPayload {
  const layerIndex = map.layers.findIndex((entry) => entry.id === layerId);
  const layer = map.layers[layerIndex];
  if (!layer) return map;
  const size = Math.max(1, map.chunkSize);
  const positions = index?.positionsOf(layer.chunks);
  if (index && positions) {
    const edited = editedChunks(map, size, writes, (key) => {
      const at = positions.get(key);
      return at === undefined ? undefined : layer.chunks[at];
    });
    if (edited.size === 0) return map;
    const chunks = [...layer.chunks];
    const dropped = new Set<number>();
    const added: TilemapChunk[] = [];
    for (const [key, next] of edited) {
      const at = positions.get(key);
      if (at === undefined) {
        if (isOccupied(next)) added.push(next);
      } else if (isOccupied(next)) {
        chunks[at] = { ...chunks[at]!, tiles: next.tiles };
      } else {
        dropped.add(at);
      }
    }
    const kept = dropped.size === 0 ? chunks : chunks.filter((_, at) => !dropped.has(at));
    for (const chunk of added) kept.push(chunk);
    // Dropping a chunk shifts later positions; the index then rebuilds on its next use.
    if (dropped.size === 0) index.followAppend(kept, added);
    return withLayerChunks(map, layerIndex, layer, kept);
  }
  const existing = new Map(layer.chunks.map((chunk) => [`${chunk.cx},${chunk.cy}`, chunk]));
  const edited = editedChunks(map, size, writes, (key) => existing.get(key));
  if (edited.size === 0) return map;
  const chunks: TilemapChunk[] = [];
  for (const chunk of layer.chunks) {
    const key = `${chunk.cx},${chunk.cy}`;
    const next = edited.get(key);
    if (!next) {
      chunks.push(chunk);
      continue;
    }
    edited.delete(key);
    if (isOccupied(next)) chunks.push({ ...chunk, tiles: next.tiles });
  }
  for (const chunk of edited.values()) if (isOccupied(chunk)) chunks.push(chunk);
  return withLayerChunks(map, layerIndex, layer, chunks);
}

function withLayerChunks(
  map: TilemapPayload,
  layerIndex: number,
  layer: TilemapLayer,
  chunks: TilemapChunk[],
): TilemapPayload {
  const layers = [...map.layers];
  layers[layerIndex] = { ...layer, chunks };
  return { ...map, layers };
}

function normalizeLayers(value: unknown, chunkSize: number): TilemapLayer[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const row =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const id =
      typeof row.id === "string" && row.id.trim() !== ""
        ? row.id
        : `layer-${index + 1}`;
    const parallax =
      row.parallax && typeof row.parallax === "object"
        ? (row.parallax as { x?: number; y?: number })
        : {};
    return {
      id,
      name: typeof row.name === "string" && row.name.trim() !== "" ? row.name : id,
      visible: row.visible !== false,
      collision: row.collision !== false,
      sortingLayer:
        typeof row.sortingLayer === "string" && row.sortingLayer.trim() !== ""
          ? row.sortingLayer
          : "Default",
      orderInLayer: Number.isFinite(Number(row.orderInLayer))
        ? Number(row.orderInLayer)
        : 0,
      parallax: {
        x: Number.isFinite(Number(parallax.x)) ? Number(parallax.x) : 1,
        y: Number.isFinite(Number(parallax.y)) ? Number(parallax.y) : 1,
      },
      chunks: normalizeChunks(row.chunks, chunkSize),
    };
  });
}

function normalizeChunks(value: unknown, chunkSize: number): TilemapChunk[] {
  if (!Array.isArray(value)) return [];
  const length = chunkSize * chunkSize;
  return value.map((entry) => {
    const row =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const raw = Array.isArray(row.tiles) ? row.tiles.map((n) => Number(n) || 0) : [];
    const tiles = emptyChunkTiles(chunkSize);
    for (let i = 0; i < Math.min(length, raw.length); i++) {
      tiles[i] = raw[i]!;
    }
    return {
      cx: Number.isFinite(Number(row.cx)) ? Math.floor(Number(row.cx)) : 0,
      cy: Number.isFinite(Number(row.cy)) ? Math.floor(Number(row.cy)) : 0,
      tiles,
    };
  });
}

export function resizeTilemap(
  map: TilemapPayload,
  width: number,
  height: number,
): TilemapPayload {
  const nextWidth = Math.max(1, Math.floor(width) || 1);
  const nextHeight = Math.max(1, Math.floor(height) || 1);
  const size = Math.max(1, map.chunkSize);
  const length = size * size;
  const layers = map.layers.map((layer) => {
    const chunks: TilemapChunk[] = [];
    for (const chunk of layer.chunks) {
      const tiles = [...chunk.tiles];
      let occupied = false;
      for (let i = 0; i < length; i++) {
        const lx = i % size;
        const ly = Math.floor(i / size);
        const gx = chunk.cx * size + lx;
        const gy = chunk.cy * size + ly;
        if (gx < 0 || gy < 0 || gx >= nextWidth || gy >= nextHeight) {
          tiles[i] = 0;
        }
        if ((tiles[i] ?? 0) > 0) occupied = true;
      }
      if (occupied) chunks.push({ ...chunk, tiles });
    }
    return { ...layer, chunks };
  });
  return { ...map, width: nextWidth, height: nextHeight, layers };
}

function occupiedTileExtent(
  layers: readonly TilemapLayer[],
  chunkSize: number,
): { width: number; height: number } {
  const size = Math.max(1, chunkSize);
  let maxX = -1;
  let maxY = -1;
  for (const layer of layers) {
    for (const chunk of layer.chunks) {
      for (let ly = 0; ly < size; ly++) {
        for (let lx = 0; lx < size; lx++) {
          const id = chunk.tiles[localIndex(lx, ly, size)] ?? 0;
          if (id <= 0) continue;
          maxX = Math.max(maxX, chunk.cx * size + lx);
          maxY = Math.max(maxY, chunk.cy * size + ly);
        }
      }
    }
  }
  return { width: maxX + 1, height: maxY + 1 };
}

function normalizeMapSize(value: unknown, occupied: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return Math.max(DEFAULT_TILEMAP_WIDTH, occupied);
}

function posMod(n: number, d: number): number {
  return ((n % d) + d) % d;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Stable list order breaks ties after the same project sort keys used by render. */
export function orderedTilemapLayers(map: TilemapPayload, layers: readonly string[]): TilemapLayer[] {
  return [...map.layers].sort((a, b) => sortingLayerSortKey(layers, a.sortingLayer, a.orderInLayer) - sortingLayerSortKey(layers, b.sortingLayer, b.orderInLayer));
}
