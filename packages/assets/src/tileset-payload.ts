/** Tileset asset payload: atlas grid plus per-tile collision and flags (engineplan §13.3). */

export type TilesetChainCollision = {
  kind: "chain";
  points: Array<{ x: number; y: number }>;
};

export type TilesetCollision = "none" | "full" | TilesetChainCollision;

export interface TilesetTile {
  id: number;
  collision: TilesetCollision;
  flags: number;
  animation: number[];
}

export interface TilesetPayload {
  textureGuid: string | null;
  atlasWidth: number;
  atlasHeight: number;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  tiles: TilesetTile[];
}

export interface TileUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_TILE = 16;

export function createDefaultTilesetPayload(): TilesetPayload {
  return {
    textureGuid: null,
    atlasWidth: DEFAULT_TILE,
    atlasHeight: DEFAULT_TILE,
    tileWidth: DEFAULT_TILE,
    tileHeight: DEFAULT_TILE,
    margin: 0,
    spacing: 0,
    tiles: [{ id: 1, collision: "none", flags: 0, animation: [] }],
  };
}

export function normalizeTilesetPayload(value: unknown): TilesetPayload {
  const source =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const tileWidth = positiveInt(source.tileWidth, DEFAULT_TILE);
  const tileHeight = positiveInt(source.tileHeight, DEFAULT_TILE);
  const atlasWidth = positiveInt(source.atlasWidth, tileWidth);
  const atlasHeight = positiveInt(source.atlasHeight, tileHeight);
  return {
    textureGuid: stringOrNull(source.textureGuid),
    atlasWidth,
    atlasHeight,
    tileWidth,
    tileHeight,
    margin: nonNegativeInt(source.margin, 0),
    spacing: nonNegativeInt(source.spacing, 0),
    tiles: normalizeTiles(source.tiles),
  };
}

export function tilesetTileById(
  tileset: TilesetPayload,
  tileId: number,
): TilesetTile | null {
  if (tileId <= 0) return null;
  return tileset.tiles.find((tile) => tile.id === tileId) ?? null;
}

/** Columns in the atlas grid (Tiled formula). */
export function tilesetAtlasColumns(tileset: TilesetPayload): number {
  const stride = tileset.tileWidth + tileset.spacing;
  if (stride <= 0) return 1;
  const usable = tileset.atlasWidth - 2 * tileset.margin + tileset.spacing;
  return Math.max(1, Math.floor(usable / stride));
}

export function tilesetAtlasRows(tileset: TilesetPayload): number {
  const stride = tileset.tileHeight + tileset.spacing;
  if (stride <= 0) return 1;
  const usable = tileset.atlasHeight - 2 * tileset.margin + tileset.spacing;
  return Math.max(1, Math.floor(usable / stride));
}

/** Ensure every atlas cell has a tile record so collision/flags/animation can be authored. */
export function ensureTilesetTiles(tileset: TilesetPayload): TilesetPayload {
  const count = tilesetAtlasColumns(tileset) * tilesetAtlasRows(tileset);
  const byId = new Map(tileset.tiles.map((tile) => [tile.id, tile]));
  const tiles: TilesetTile[] = [];
  for (let id = 1; id <= count; id++) {
    tiles.push(
      byId.get(id) ?? { id, collision: "none", flags: 0, animation: [] },
    );
  }
  return { ...tileset, tiles };
}

/** Image-space source rect for canvas `drawImage`. Row 0 is the top of the atlas. */
export function tilesetTileRect(
  tileset: TilesetPayload,
  tileId: number,
): TileRect | null {
  if (tileId <= 0) return null;
  const columns = tilesetAtlasColumns(tileset);
  const rows = tilesetAtlasRows(tileset);
  const index = tileId - 1;
  const col = index % columns;
  const row = Math.floor(index / columns);
  if (row < 0 || row >= rows) return null;
  const { tileWidth, tileHeight, margin, spacing } = tileset;
  return {
    x: margin + col * (tileWidth + spacing),
    y: margin + row * (tileHeight + spacing),
    width: tileWidth,
    height: tileHeight,
  };
}

/**
 * Normalized UVs for a 1-based atlas cell. Image-space row 0 is the top of the
 * texture; GL `v=0` is the bottom, so V is flipped.
 */
export function tilesetTileUv(
  tileset: TilesetPayload,
  tileId: number,
): TileUv | null {
  const rect = tilesetTileRect(tileset, tileId);
  if (!rect) return null;
  const { atlasWidth, atlasHeight } = tileset;
  if (atlasWidth <= 0 || atlasHeight <= 0) return null;
  const u0 = rect.x / atlasWidth;
  const u1 = (rect.x + rect.width) / atlasWidth;
  const vTop = rect.y / atlasHeight;
  const vBottom = (rect.y + rect.height) / atlasHeight;
  return {
    u0: roundUv(u0),
    v0: roundUv(1 - vBottom),
    u1: roundUv(u1),
    v1: roundUv(1 - vTop),
  };
}

/** Map a pointer on a displayed atlas image onto a 1-based tile id (0 if outside). */
export function atlasCellAt(options: {
  localX: number;
  localY: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
  tileset: TilesetPayload;
}): number {
  const { localX, localY, imageX, imageY, imageWidth, imageHeight, tileset } =
    options;
  if (imageWidth <= 0 || imageHeight <= 0) return 0;
  if (
    localX < imageX ||
    localY < imageY ||
    localX >= imageX + imageWidth ||
    localY >= imageY + imageHeight
  ) {
    return 0;
  }
  const ix = ((localX - imageX) / imageWidth) * tileset.atlasWidth;
  const iy = ((localY - imageY) / imageHeight) * tileset.atlasHeight;
  const strideX = tileset.tileWidth + tileset.spacing;
  const strideY = tileset.tileHeight + tileset.spacing;
  if (strideX <= 0 || strideY <= 0) return 0;
  const innerX = ix - tileset.margin;
  const innerY = iy - tileset.margin;
  if (innerX < 0 || innerY < 0) return 0;
  const col = Math.floor(innerX / strideX);
  const row = Math.floor(innerY / strideY);
  const inTileX = innerX - col * strideX;
  const inTileY = innerY - row * strideY;
  if (inTileX >= tileset.tileWidth || inTileY >= tileset.tileHeight) return 0;
  const columns = tilesetAtlasColumns(tileset);
  const rows = tilesetAtlasRows(tileset);
  if (col < 0 || row < 0 || col >= columns || row >= rows) return 0;
  return row * columns + col + 1;
}

function roundUv(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

function normalizeTiles(value: unknown): TilesetTile[] {
  if (!Array.isArray(value)) return createDefaultTilesetPayload().tiles;
  const seen = new Set<number>();
  const tiles: TilesetTile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    tiles.push({
      id,
      collision: normalizeCollision(row.collision),
      flags: nonNegativeInt(row.flags, 0),
      animation: Array.isArray(row.animation)
        ? row.animation.map((n) => Number(n) || 0).filter((n) => n > 0)
        : [],
    });
  }
  return tiles;
}

function normalizeCollision(value: unknown): TilesetCollision {
  if (value === "full") return "full";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (row.kind === "chain") {
      const points = Array.isArray(row.points)
        ? row.points.map((point) => {
            const pt = (point ?? {}) as { x?: number; y?: number };
            return { x: Number(pt.x) || 0, y: Number(pt.y) || 0 };
          })
        : [];
      return { kind: "chain", points };
    }
  }
  return "none";
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
