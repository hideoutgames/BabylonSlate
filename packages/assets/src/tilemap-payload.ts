/** Tilemap asset payload: ordered layers of chunked tile ids (engineplan §13.3). */

import {
  ensureTilesetTiles,
  type TilesetPayload,
} from "./tileset-payload";

export const DEFAULT_TILEMAP_CHUNK_SIZE = 32;

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
  tilesetGuid: string | null;
  tilesets: TilemapTilesetRef[];
  tileWidth: number;
  tileHeight: number;
  chunkSize: number;
  layers: TilemapLayer[];
}

export function emptyChunkTiles(chunkSize: number): number[] {
  const size = Math.max(1, chunkSize);
  return Array.from({ length: size * size }, () => 0);
}

export function createDefaultTilemapPayload(): TilemapPayload {
  return {
    tilesetGuid: null,
    tilesets: [],
    tileWidth: 16,
    tileHeight: 16,
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
  if (map.tilesetGuid && !seen.has(map.tilesetGuid)) {
    guids.unshift(map.tilesetGuid);
  }
  return guids;
}

/** Tiled GID: `firstGid + localId - 1`. Local id 1 is the first atlas cell. */
export function encodeTileGid(firstGid: number, localId: number): number {
  if (localId <= 0 || firstGid <= 0) return 0;
  return firstGid + localId - 1;
}

export function decodeTileGid(
  map: TilemapPayload,
  gid: number,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): TileGidHit | null {
  if (!Number.isInteger(gid) || gid <= 0) return null;
  let chosen: TilemapTilesetRef | null = null;
  for (const ref of map.tilesets) {
    if (ref.firstGid <= gid && (!chosen || ref.firstGid > chosen.firstGid)) {
      chosen = ref;
    }
  }
  if (!chosen) return null;
  const tileset = tilesets.get(chosen.guid);
  if (!tileset) return null;
  const count =
    chosen.tileCount > 0
      ? chosen.tileCount
      : ensureTilesetTiles(tileset).tiles.length;
  const localId = gid - chosen.firstGid + 1;
  if (count > 0 && (localId < 1 || localId > count)) return null;
  return { guid: chosen.guid, localId, tileset };
}

export function addTilemapTileset(
  map: TilemapPayload,
  guid: string,
  tileset: TilesetPayload,
  knownTilesets?: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  if (!guid) return map;
  if (map.tilesets.some((ref) => ref.guid === guid)) return map;
  const count = Math.max(1, ensureTilesetTiles(tileset).tiles.length);
  const firstGid = nextTilesetFirstGid(map, knownTilesets);
  const tilesets = [...map.tilesets, { guid, firstGid, tileCount: count }];
  return { ...map, tilesets, tilesetGuid: tilesets[0]?.guid ?? null };
}

export function removeTilemapTileset(
  map: TilemapPayload,
  guid: string,
): TilemapPayload {
  const tilesets = map.tilesets.filter((ref) => ref.guid !== guid);
  return { ...map, tilesets, tilesetGuid: tilesets[0]?.guid ?? null };
}

function nextTilesetFirstGid(
  map: TilemapPayload,
  knownTilesets?: ReadonlyMap<string, TilesetPayload>,
): number {
  let next = 1;
  for (const ref of map.tilesets) {
    let count = ref.tileCount;
    if (count <= 0) {
      const payload = knownTilesets?.get(ref.guid);
      count = payload ? ensureTilesetTiles(payload).tiles.length : 1;
    }
    next = Math.max(next, ref.firstGid + Math.max(1, count));
  }
  return next;
}

export function normalizeTilemapPayload(value: unknown): TilemapPayload {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const chunkSize = positiveInt(source.chunkSize, DEFAULT_TILEMAP_CHUNK_SIZE);
  const layers = normalizeLayers(source.layers, chunkSize);
  const tilesets = normalizeTilesetRefs(source.tilesets, source.tilesetGuid);
  return {
    tilesetGuid: tilesets[0]?.guid ?? null,
    tilesets,
    tileWidth: positiveInt(source.tileWidth, 16),
    tileHeight: positiveInt(source.tileHeight, 16),
    chunkSize,
    layers: layers.length > 0 ? layers : createDefaultTilemapPayload().layers,
  };
}

function normalizeTilesetRefs(
  value: unknown,
  legacyGuid: unknown,
): TilemapTilesetRef[] {
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
        tileCount: nonNegativeInt(row.tileCount, 0),
      });
    }
  }
  const fallback = stringOrNull(legacyGuid);
  if (refs.length === 0 && fallback) {
    refs.push({ guid: fallback, firstGid: 1, tileCount: 0 });
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
  const id = Number.isInteger(tileId) && tileId > 0 ? tileId : 0;
  return {
    ...map,
    layers: map.layers.map((layer) => {
      if (layer.id !== layerId) return layer;
      const { cx, cy, lx, ly } = chunkCoordForTile(gx, gy, map.chunkSize);
      const index = localIndex(lx, ly, map.chunkSize);
      const existing = layer.chunks.find(
        (entry) => entry.cx === cx && entry.cy === cy,
      );
      const tiles = existing
        ? [...existing.tiles]
        : emptyChunkTiles(map.chunkSize);
      tiles[index] = id;
      const chunks = existing
        ? layer.chunks.map((entry) =>
            entry.cx === cx && entry.cy === cy ? { ...entry, tiles } : entry,
          )
        : [...layer.chunks, { cx, cy, tiles }];
      return { ...layer, chunks };
    }),
  };
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

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
