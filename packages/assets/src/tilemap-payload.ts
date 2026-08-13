/** Tilemap asset payload: ordered layers of chunked tile ids (engineplan §13.3). */

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

export interface TilemapPayload {
  tilesetGuid: string | null;
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
    tileWidth: 16,
    tileHeight: 16,
    chunkSize: DEFAULT_TILEMAP_CHUNK_SIZE,
    layers: [createDefaultLayer("layer-1", "Ground")],
  };
}

export function normalizeTilemapPayload(value: unknown): TilemapPayload {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const chunkSize = positiveInt(source.chunkSize, DEFAULT_TILEMAP_CHUNK_SIZE);
  const layers = normalizeLayers(source.layers, chunkSize);
  return {
    tilesetGuid: stringOrNull(source.tilesetGuid),
    tileWidth: positiveInt(source.tileWidth, 16),
    tileHeight: positiveInt(source.tileHeight, 16),
    chunkSize,
    layers: layers.length > 0 ? layers : createDefaultTilemapPayload().layers,
  };
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

function createDefaultLayer(id: string, name: string): TilemapLayer {
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
