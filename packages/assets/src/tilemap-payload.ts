import { sortingLayerSortKey } from "@haptic/core";
/** Tilemap asset payload: ordered layers of chunked tile ids (engineplan §13.3). */

import {
  tilesetAtlasColumns,
  tilesetAtlasRows,
  type TilesetPayload,
} from "./tileset-payload";
import { tilesetTerrainStamp } from "./tileset-terrain";

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
  /**
   * The Tileset's `tilesetTerrainStamp` when this map's terrain cells were
   * last resolved against it; omitted until then. A differing stamp makes
   * `refreshStaleTilemapTerrains` re-resolve that Tileset's terrain cells.
   */
  terrainStamp?: string;
}

export interface TileGidHit {
  guid: string;
  localId: number;
  tileset: TilesetPayload;
}

/** A point of a map in tile units, +Y up: cell (x, y) spans x..x+1, y..y+1. */
export interface TilemapPivot {
  x: number;
  y: number;
}

interface TilemapPayloadFields {
  tilesets: TilemapTilesetRef[];
  tileWidth: number;
  tileHeight: number;
  chunkSize: number;
  layers: TilemapLayer[];
}

/**
 * A map of a fixed size: cells 0 ≤ x < `width`, 0 ≤ y < `height` (+Y up), the
 * bottom-left corner of cell (0, 0) at the actor's origin. Storage stays sparse chunks.
 */
export interface BoundedTilemapPayload extends TilemapPayloadFields {
  unbounded?: undefined;
  width: number;
  height: number;
  pivot?: undefined;
}

/**
 * A map with no size: cells at any integer coordinates (within
 * `TILEMAP_CELL_LIMIT`), negative ones included. `pivot` is the map point at
 * the actor's origin, in tile units snapped to half cells. A `width` or
 * `height` it carries means nothing, and normalizing drops it.
 */
export interface UnboundedTilemapPayload extends TilemapPayloadFields {
  unbounded: true;
  pivot: TilemapPivot;
  width?: number;
  height?: number;
}

export type TilemapPayload = BoundedTilemapPayload | UnboundedTilemapPayload;

/**
 * Largest |cell coordinate| of an unbounded map: `tilemapCellKey` keeps cells
 * distinct below 2^20, so writes past it are dropped as outside the map.
 */
export const TILEMAP_CELL_LIMIT = 2 ** 20 - 1;

/** The map point at the actor's origin of every bounded map: the bottom-left corner of cell (0, 0). */
const BOUNDED_PIVOT: Readonly<TilemapPivot> = Object.freeze({ x: 0, y: 0 });

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
  // No cell uses the Tileset yet, so the map starts current with its terrains.
  const ref = { guid, firstGid, tileCount: count, terrainStamp: tilesetTerrainStamp(tileset) };
  return { ...reconciled, tilesets: [...reconciled.tilesets, ref] };
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

/**
 * A valid Tilemap payload from any stored value. Parts of `value` that are
 * already in normalized form are kept as the same objects (a layer, a chunk,
 * its `tiles` array, the Tileset list), and an already normalized payload is
 * returned as itself, so normalizing the editor's working map again costs one
 * read of its cells and keeps every identity that caches and deltas key on.
 * Payloads are never changed in place, so sharing them is safe.
 */
export function normalizeTilemapPayload(value: unknown): TilemapPayload {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const chunkSize = positiveInt(source.chunkSize, DEFAULT_TILEMAP_CHUNK_SIZE);
  const layers = normalizeLayers(source.layers, chunkSize);
  const tilesets = normalizeTilesetRefs(source.tilesets);
  const resolvedLayers =
    layers.length > 0 ? layers : createDefaultTilemapPayload().layers;
  const tileWidth = positiveInt(source.tileWidth, 16);
  const tileHeight = positiveInt(source.tileHeight, 16);
  if (source.unbounded === true) {
    // An unbounded map has no size: a stored `width`/`height` is dropped.
    const pivot = normalizePivot(source.pivot);
    if (
      hasExactKeys(source, UNBOUNDED_TILEMAP_KEYS) &&
      tilesets === source.tilesets &&
      resolvedLayers === source.layers &&
      tileWidth === source.tileWidth &&
      tileHeight === source.tileHeight &&
      chunkSize === source.chunkSize &&
      pivot === source.pivot
    ) {
      return source as unknown as UnboundedTilemapPayload;
    }
    return { tilesets, tileWidth, tileHeight, unbounded: true, pivot, chunkSize, layers: resolvedLayers };
  }
  const storedWidth = storedMapSize(source.width);
  const storedHeight = storedMapSize(source.height);
  // Only a payload without a stored size reads its painted extent.
  const extent = storedWidth !== null && storedHeight !== null
    ? null
    : tilemapPaintedExtent({ layers: resolvedLayers, chunkSize });
  const width = storedWidth ?? Math.max(DEFAULT_TILEMAP_WIDTH, extent ? extent.maxX + 1 : 0);
  const height = storedHeight ?? Math.max(DEFAULT_TILEMAP_HEIGHT, extent ? extent.maxY + 1 : 0);
  if (
    hasExactKeys(source, TILEMAP_KEYS) &&
    tilesets === source.tilesets &&
    resolvedLayers === source.layers &&
    tileWidth === source.tileWidth &&
    tileHeight === source.tileHeight &&
    width === source.width &&
    height === source.height &&
    chunkSize === source.chunkSize
  ) {
    return source as unknown as BoundedTilemapPayload;
  }
  return { tilesets, tileWidth, tileHeight, width, height, chunkSize, layers: resolvedLayers };
}

const TILEMAP_KEYS = ["tilesets", "tileWidth", "tileHeight", "width", "height", "chunkSize", "layers"] as const;
const UNBOUNDED_TILEMAP_KEYS = ["tilesets", "tileWidth", "tileHeight", "unbounded", "pivot", "chunkSize", "layers"] as const;
const LAYER_KEYS = ["id", "name", "visible", "collision", "sortingLayer", "orderInLayer", "parallax", "chunks"] as const;
const CHUNK_KEYS = ["cx", "cy", "tiles"] as const;

/** `value` has exactly these own keys, so keeping it adds and drops nothing. */
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A stored map size, or `null` when the payload has none (it then follows the painted extent). */
function storedMapSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * A pivot coordinate snapped to the nearest half cell (a cell corner, edge
 * middle or centre), within `TILEMAP_CELL_LIMIT`; anything else is 0.
 */
export function snapTilemapPivot(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const snapped = Math.round(Math.min(TILEMAP_CELL_LIMIT, Math.max(-TILEMAP_CELL_LIMIT, number)) * 2) / 2;
  // `Math.round(-0.2)` is -0; a stored pivot never carries it.
  return snapped === 0 ? 0 : snapped;
}

/** A stored pivot, kept as the same object when it already holds snapped `x` and `y` only. */
function normalizePivot(value: unknown): TilemapPivot {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const x = snapTilemapPivot(row.x);
  const y = snapTilemapPivot(row.y);
  if (x === row.x && y === row.y && !Object.is(row.x, -0) && !Object.is(row.y, -0) && hasExactKeys(row, ["x", "y"])) {
    return row as unknown as TilemapPivot;
  }
  return { x, y };
}

function normalizeTilesetRefs(value: unknown): TilemapTilesetRef[] {
  const refs: TilemapTilesetRef[] = [];
  const seen = new Set<string>();
  let kept = Array.isArray(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") {
        kept = false;
        continue;
      }
      const row = entry as Record<string, unknown>;
      const guid = stringOrNull(row.guid);
      if (!guid || seen.has(guid)) {
        kept = false;
        continue;
      }
      seen.add(guid);
      const terrainStamp = stringOrNull(row.terrainStamp);
      const ref: TilemapTilesetRef = {
        guid,
        firstGid: positiveInt(row.firstGid, 1),
        // Every saved range reserves at least one tile; the next edit grows it to the atlas.
        tileCount: Math.max(1, positiveInt(row.tileCount, 1)),
        ...(terrainStamp ? { terrainStamp } : {}),
      };
      const same = ref.firstGid === row.firstGid && ref.tileCount === row.tileCount &&
        hasExactKeys(row, terrainStamp ? ["guid", "firstGid", "tileCount", "terrainStamp"] : ["guid", "firstGid", "tileCount"]);
      if (same) refs.push(row as unknown as TilemapTilesetRef);
      else {
        kept = false;
        refs.push(ref);
      }
    }
  }
  return kept ? (value as TilemapTilesetRef[]) : refs;
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

/**
 * Whether cell (gx, gy) is part of the map: inside `width` × `height` from
 * cell (0, 0) for a bounded map; any cell within `TILEMAP_CELL_LIMIT` on both
 * axes for an unbounded one, negative coordinates included.
 */
export function tileInBounds(
  map: Pick<BoundedTilemapPayload, "unbounded" | "width" | "height"> | Pick<UnboundedTilemapPayload, "unbounded">,
  gx: number,
  gy: number,
): boolean {
  if (map.unbounded) return Math.abs(gx) <= TILEMAP_CELL_LIMIT && Math.abs(gy) <= TILEMAP_CELL_LIMIT;
  return gx >= 0 && gy >= 0 && gx < map.width && gy < map.height;
}

/** The map point at the actor's origin: an unbounded map's `pivot`, (0, 0) for a bounded map. */
export function tilemapPivot(map: Pick<BoundedTilemapPayload, "unbounded" | "pivot"> | Pick<UnboundedTilemapPayload, "unbounded" | "pivot">): Readonly<TilemapPivot> {
  return map.unbounded ? map.pivot : BOUNDED_PIVOT;
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
  private positions = new Map<number, number>();
  private unique = true;
  private readonly advance: boolean;

  constructor(advance = false) {
    this.advance = advance;
  }

  /** Chunk positions by `tilemapCellKey(cx, cy)`, or `null` when two chunks share a key. */
  positionsOf(chunks: readonly TilemapChunk[]): ReadonlyMap<number, number> | null {
    if (this.chunks !== chunks) {
      const positions = new Map<number, number>();
      for (let at = 0; at < chunks.length; at++) {
        positions.set(tilemapCellKey(chunks[at]!.cx, chunks[at]!.cy), at);
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
      this.positions.set(tilemapCellKey(added[i]!.cx, added[i]!.cy), next.length - added.length + i);
    }
    this.chunks = next;
  }
}

function isOccupied(chunk: TilemapChunk): boolean {
  return chunk.tiles.some((gid) => gid > 0);
}

/** Chunks changed by `writes`, as copies, keyed by `tilemapCellKey(cx, cy)` in the order they first changed. */
function editedChunks(
  map: TilemapPayload,
  size: number,
  writes: Iterable<TileWrite>,
  existing: (key: number) => TilemapChunk | undefined,
): Map<number, TilemapChunk> {
  const edited = new Map<number, TilemapChunk>();
  // Large writes (a moved selection) run here per cell, so the chunk and index are worked out without allocating.
  let last: TilemapChunk | undefined;
  for (const write of writes) {
    if (!tileInBounds(map, write.x, write.y)) continue;
    const id = Number.isInteger(write.id) && write.id > 0 ? write.id : 0;
    const cx = Math.floor(write.x / size);
    const cy = Math.floor(write.y / size);
    const index = localIndex(write.x - cx * size, write.y - cy * size, size);
    if (last && last.cx === cx && last.cy === cy) {
      last.tiles[index] = id;
      continue;
    }
    const key = tilemapCellKey(cx, cy);
    let chunk = edited.get(key);
    if (!chunk) {
      const current = existing(key);
      if ((current?.tiles[index] ?? 0) === id) continue;
      chunk = { cx, cy, tiles: current ? [...current.tiles] : emptyChunkTiles(size) };
      edited.set(key, chunk);
    }
    last = chunk;
    chunk.tiles[index] = id;
  }
  return edited;
}

/**
 * Write many cells, copying each touched chunk once. Cells outside the map
 * (`tileInBounds`) are skipped: a bounded map clips at its size, an unbounded
 * one writes any cell, negative ones included. Storage stays sparse: erasing never allocates a chunk, and a chunk
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
  const existing = new Map(layer.chunks.map((chunk) => [tilemapCellKey(chunk.cx, chunk.cy), chunk]));
  const edited = editedChunks(map, size, writes, (key) => existing.get(key));
  if (edited.size === 0) return map;
  const chunks: TilemapChunk[] = [];
  for (const chunk of layer.chunks) {
    const key = tilemapCellKey(chunk.cx, chunk.cy);
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
  let kept = true;
  const layers = value.map((entry, index) => {
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
    const layer: TilemapLayer = {
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
    const same =
      hasExactKeys(row, LAYER_KEYS) &&
      layer.id === row.id &&
      layer.name === row.name &&
      layer.visible === row.visible &&
      layer.collision === row.collision &&
      layer.sortingLayer === row.sortingLayer &&
      layer.orderInLayer === row.orderInLayer &&
      layer.chunks === row.chunks &&
      hasExactKeys(parallax, ["x", "y"]) &&
      layer.parallax.x === parallax.x &&
      layer.parallax.y === parallax.y;
    if (same) return row as unknown as TilemapLayer;
    kept = false;
    return layer;
  });
  return kept ? (value as TilemapLayer[]) : layers;
}

/** Whether `tiles` already holds what normalizing it would: `length` numbers, none NaN or -0. */
function isNormalizedTiles(tiles: unknown, length: number): tiles is number[] {
  if (!Array.isArray(tiles) || tiles.length !== length) return false;
  for (let i = 0; i < length; i++) {
    const n: unknown = tiles[i];
    if (typeof n !== "number" || Number.isNaN(n) || Object.is(n, -0)) return false;
  }
  return true;
}

function normalizeChunks(value: unknown, chunkSize: number): TilemapChunk[] {
  if (!Array.isArray(value)) return [];
  const length = chunkSize * chunkSize;
  let kept = true;
  const chunks = value.map((entry) => {
    const row =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const cx = Number.isFinite(Number(row.cx)) ? Math.floor(Number(row.cx)) : 0;
    const cy = Number.isFinite(Number(row.cy)) ? Math.floor(Number(row.cy)) : 0;
    let tiles: number[];
    if (isNormalizedTiles(row.tiles, length)) {
      tiles = row.tiles;
    } else {
      const raw = Array.isArray(row.tiles) ? row.tiles.map((n) => Number(n) || 0) : [];
      tiles = emptyChunkTiles(chunkSize);
      for (let i = 0; i < Math.min(length, raw.length); i++) {
        tiles[i] = raw[i]!;
      }
    }
    if (tiles === row.tiles && cx === row.cx && cy === row.cy && hasExactKeys(row, CHUNK_KEYS)) {
      return row as unknown as TilemapChunk;
    }
    kept = false;
    return { cx, cy, tiles };
  });
  const merged = mergeDuplicateChunks(chunks, length);
  if (merged !== chunks) return merged;
  return kept ? (value as TilemapChunk[]) : chunks;
}

/**
 * One chunk per (cx, cy), negative coordinates included: a chunk listed again
 * folds into the first one with that key, its non-empty cells written over the
 * earlier ones (the later chunk draws on top). Returns `chunks` itself when every key is unique.
 */
function mergeDuplicateChunks(chunks: TilemapChunk[], length: number): TilemapChunk[] {
  const counts = new Map<number, number>();
  for (const chunk of chunks) {
    const key = tilemapCellKey(chunk.cx, chunk.cy);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === chunks.length) return chunks;
  const merged: TilemapChunk[] = [];
  const byKey = new Map<number, TilemapChunk>();
  for (const chunk of chunks) {
    const key = tilemapCellKey(chunk.cx, chunk.cy);
    // A chunk listed once keeps its object.
    if (counts.get(key) === 1) {
      merged.push(chunk);
      continue;
    }
    const target = byKey.get(key);
    if (!target) {
      const copy = { cx: chunk.cx, cy: chunk.cy, tiles: [...chunk.tiles] };
      byKey.set(key, copy);
      merged.push(copy);
      continue;
    }
    for (let i = 0; i < length; i++) {
      const gid = chunk.tiles[i]!;
      if (gid > 0) target.tiles[i] = gid;
    }
  }
  return merged;
}

/**
 * The same cells in chunks of `chunkSize`, every layer re-cut on the new grid
 * so each tile keeps its map cell (a Chunk Size edit). Nothing is clipped,
 * empty chunks are dropped, and new chunks list bottom row first, left to
 * right. Returns `map` itself when the size does not change.
 */
export function rechunkTilemap(map: TilemapPayload, chunkSize: number): TilemapPayload {
  const size = Math.max(1, Math.floor(chunkSize) || 1);
  if (size === Math.max(1, map.chunkSize)) return map;
  return { ...map, chunkSize: size, layers: recutLayers(map, size, 0, 0) };
}

/**
 * Every layer's cells moved by (`dx`, `dy`) whole cells and cut into chunks of
 * `size`, bottom row first, left to right; empty chunks are dropped.
 */
function recutLayers(map: TilemapPayload, size: number, dx: number, dy: number): TilemapLayer[] {
  const from = Math.max(1, map.chunkSize);
  return map.layers.map((layer) => {
    const byKey = new Map<number, TilemapChunk>();
    for (const chunk of layer.chunks) {
      for (let at = 0; at < chunk.tiles.length; at++) {
        const gid = chunk.tiles[at]!;
        if (!gid) continue;
        const x = chunk.cx * from + (at % from) + dx;
        const y = chunk.cy * from + Math.floor(at / from) + dy;
        const { cx, cy, lx, ly } = chunkCoordForTile(x, y, size);
        const key = tilemapCellKey(cx, cy);
        let target = byKey.get(key);
        if (!target) {
          target = { cx, cy, tiles: emptyChunkTiles(size) };
          byKey.set(key, target);
        }
        target.tiles[localIndex(lx, ly, size)] = gid;
      }
    }
    const chunks = [...byKey.values()].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    return { ...layer, chunks };
  });
}

/** Largest |coordinate| `tilemapCellKey` keeps distinct. */
const CELL_KEY_OFFSET = 2 ** 20;
const CELL_KEY_STRIDE = 2 ** 21;

/**
 * A number naming one cell (or chunk) coordinate pair, for maps and sets that
 * key cells without building strings. Distinct for coordinates in
 * (-2^20, 2^20) on both axes, negative ones included, so it never depends on
 * the map's width or height.
 */
export function tilemapCellKey(x: number, y: number): number {
  return (y + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (x + CELL_KEY_OFFSET);
}

/**
 * A bounded map at a new size, clearing the tiles outside it; a chunk wholly
 * inside keeps its object. An unbounded map has no size and is returned as it is.
 */
export function resizeTilemap(
  map: TilemapPayload,
  width: number,
  height: number,
): TilemapPayload {
  if (map.unbounded) return map;
  const nextWidth = Math.max(1, Math.floor(width) || 1);
  const nextHeight = Math.max(1, Math.floor(height) || 1);
  const size = Math.max(1, map.chunkSize);
  const length = size * size;
  const layers = map.layers.map((layer) => {
    const chunks: TilemapChunk[] = [];
    for (const chunk of layer.chunks) {
      // A chunk wholly inside the new size keeps its object.
      if (chunk.cx >= 0 && chunk.cy >= 0 && (chunk.cx + 1) * size <= nextWidth && (chunk.cy + 1) * size <= nextHeight && isOccupied(chunk)) {
        chunks.push(chunk);
        continue;
      }
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

/** Inclusive cell bounds: the cells minX..maxX × minY..maxY. */
export interface TilemapCellRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Painted cells of one chunk's `tiles`, local to the chunk, by array (arrays are never changed in place). */
const chunkExtents = new WeakMap<readonly number[], { size: number; rect: TilemapCellRect | null }>();

function chunkLocalExtent(tiles: readonly number[], size: number): TilemapCellRect | null {
  const cached = chunkExtents.get(tiles);
  if (cached && cached.size === size) return cached.rect;
  let rect: TilemapCellRect | null = null;
  const length = Math.min(tiles.length, size * size);
  for (let at = 0; at < length; at++) {
    if (!(tiles[at]! > 0)) continue;
    const lx = at % size;
    const ly = Math.floor(at / size);
    if (!rect) rect = { minX: lx, minY: ly, maxX: lx, maxY: ly };
    else {
      if (lx < rect.minX) rect.minX = lx;
      if (lx > rect.maxX) rect.maxX = lx;
      if (ly < rect.minY) rect.minY = ly;
      if (ly > rect.maxY) rect.maxY = ly;
    }
  }
  chunkExtents.set(tiles, { size, rect });
  return rect;
}

function unionCellRect(a: TilemapCellRect | null, b: TilemapCellRect): TilemapCellRect {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * The cells a layer's tiles cover, negative coordinates included, or `null`
 * when it has none. Each chunk's part is cached on its `tiles` array, so after
 * an edit only the chunks it replaced are read again.
 */
export function tilemapLayerPaintedExtent(
  layer: Pick<TilemapLayer, "chunks">,
  chunkSize: number,
): TilemapCellRect | null {
  const size = Math.max(1, chunkSize);
  let extent: TilemapCellRect | null = null;
  for (const chunk of layer.chunks) {
    const local = chunkLocalExtent(chunk.tiles, size);
    if (!local) continue;
    const x = chunk.cx * size;
    const y = chunk.cy * size;
    extent = unionCellRect(extent, { minX: x + local.minX, minY: y + local.minY, maxX: x + local.maxX, maxY: y + local.maxY });
  }
  return extent;
}

/** The cells every layer's tiles cover together (`tilemapLayerPaintedExtent`), or `null` on an empty map. */
export function tilemapPaintedExtent(map: { layers: readonly Pick<TilemapLayer, "chunks">[]; chunkSize: number }): TilemapCellRect | null {
  let extent: TilemapCellRect | null = null;
  for (const layer of map.layers) {
    const part = tilemapLayerPaintedExtent(layer, map.chunkSize);
    if (part) extent = unionCellRect(extent, part);
  }
  return extent;
}

/**
 * The same tiles moved by (`dx`, `dy`) whole cells on every layer, re-cut on
 * the map's chunk grid. Nothing is clipped; returns `map` itself for (0, 0).
 */
export function translateTilemap(map: TilemapPayload, dx: number, dy: number): TilemapPayload {
  const x = Math.trunc(dx) || 0;
  const y = Math.trunc(dy) || 0;
  if (x === 0 && y === 0) return map;
  return { ...map, layers: recutLayers(map, Math.max(1, map.chunkSize), x, y) };
}

/**
 * How far making an unbounded map bounded moves its tiles: when any tile lies
 * left of column 0 or below row 0, the move that puts the painted extent's
 * bottom-left at cell (0, 0); otherwise (and for a bounded map) `null`.
 */
export function boundedTilemapShift(map: TilemapPayload): { x: number; y: number } | null {
  if (!map.unbounded) return null;
  const extent = tilemapPaintedExtent(map);
  if (!extent || (extent.minX >= 0 && extent.minY >= 0)) return null;
  return { x: -extent.minX, y: -extent.minY };
}

/**
 * Switch a map between bounded and unbounded, as one edit.
 *
 * - To unbounded: every tile keeps its cell and the pivot is (0, 0), the
 *   bounded origin, so nothing moves in the world; the size is dropped.
 * - To bounded: tiles move by `boundedTilemapShift` when some lie at negative
 *   cells, and the size becomes the painted extent from cell (0, 0) (64 × 64
 *   when nothing is painted); the pivot is dropped.
 *
 * Returns `map` itself when it already is what was asked.
 */
export function setTilemapUnbounded(map: TilemapPayload, unbounded: boolean): TilemapPayload {
  const { tilesets, tileWidth, tileHeight, chunkSize } = map;
  if (unbounded) {
    if (map.unbounded) return map;
    return { tilesets, tileWidth, tileHeight, unbounded: true, pivot: { x: 0, y: 0 }, chunkSize, layers: map.layers };
  }
  if (!map.unbounded) return map;
  const shift = boundedTilemapShift(map);
  const moved = shift ? translateTilemap(map, shift.x, shift.y) : map;
  const extent = tilemapPaintedExtent(moved);
  return {
    tilesets,
    tileWidth,
    tileHeight,
    width: extent ? extent.maxX + 1 : DEFAULT_TILEMAP_WIDTH,
    height: extent ? extent.maxY + 1 : DEFAULT_TILEMAP_HEIGHT,
    chunkSize,
    layers: moved.layers,
  };
}

/**
 * An unbounded map with its pivot at `pivot`, snapped to half cells
 * (`snapTilemapPivot`). Tile coordinates never change, only where the tiles
 * sit around the actor. Returns `map` itself for a bounded map or an unchanged pivot.
 */
export function setTilemapPivot(map: TilemapPayload, pivot: { x: number; y: number }): TilemapPayload {
  if (!map.unbounded) return map;
  const x = snapTilemapPivot(pivot.x);
  const y = snapTilemapPivot(pivot.y);
  if (x === map.pivot.x && y === map.pivot.y) return map;
  return { ...map, pivot: { x, y } };
}

/** The centre of a map's painted extent in tile units (always on a half cell), or `null` when nothing is painted. */
export function tilemapPaintedCenter(map: { layers: readonly Pick<TilemapLayer, "chunks">[]; chunkSize: number }): TilemapPivot | null {
  const extent = tilemapPaintedExtent(map);
  if (!extent) return null;
  return {
    x: snapTilemapPivot((extent.minX + extent.maxX + 1) / 2),
    y: snapTilemapPivot((extent.minY + extent.maxY + 1) / 2),
  };
}

/** **Center Pivot**: an unbounded map's pivot moved to its painted centre (`tilemapPaintedCenter`); `map` itself otherwise. */
export function centerTilemapPivot(map: TilemapPayload): TilemapPayload {
  const center = map.unbounded ? tilemapPaintedCenter(map) : null;
  return center ? setTilemapPivot(map, center) : map;
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
