import { tilesetAnimationFrame, tilesetTileById, tilesetTileUv, type TilesetPayload, type TilesetTile } from "./tileset-payload";

/** Babylon-free chunk geometry: one draw per chunk per atlas. */
export interface TilemapChunkVertexData {
  positions: number[];
  uvs: number[];
  indices: number[];
  animatedTiles: Array<{ uvOffset: number; tile: TilesetTile; tileset: TilesetPayload }>;
  /** RGBA per vertex, only when `placeholderColors` was requested. */
  colors?: number[];
}

/**
 * Stand-in colour of a tile whose Tileset has no atlas image (hue in degrees,
 * saturation and lightness in percent). The paint canvas and the chunk meshes
 * draw the same colour so a painted map looks alike in both.
 */
export function tilePlaceholderHsl(gid: number): { h: number; s: number; l: number } {
  return { h: (gid * 47) % 360, s: 55, l: 48 };
}

function tilePlaceholderRgb(gid: number): [number, number, number] {
  const { h, s, l } = tilePlaceholderHsl(gid);
  const chroma = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l / 100 - chroma / 2;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second],
    [0, second, chroma], [second, 0, chroma], [chroma, 0, second]][sector]!;
  return [r! + base, g! + base, b! + base];
}

export type TilemapChunkDrawKind = "static" | "animated";

/** One draw of a chunk: the tiles of one atlas, static or animated (`tilemapChunkDraws`). */
export interface TilemapChunkDraw {
  guid: string;
  /** The atlas's place among the chunk's atlases, in the order their first tile appears. */
  atlasIndex: number;
  tileset: TilesetPayload;
  kind: TilemapChunkDrawKind;
  data: TilemapChunkVertexData;
}

/**
 * Every draw of one chunk in a single pass over its tiles: per atlas in the
 * order its first tile appears, the static draw, then the animated one; draws
 * without tiles are left out. Each draw holds exactly what
 * `tilemapChunkVertexData` builds for that atlas and kind.
 */
export function tilemapChunkDraws(options: {
  tiles: readonly number[];
  chunkSize: number;
  chunkX: number;
  chunkY: number;
  worldTileWidth: number;
  worldTileHeight: number;
  resolveGid: (gid: number) => { tileset: TilesetPayload; localId: number; guid: string } | null;
  /** Emit placeholder colours for an atlas without an image (`tilePlaceholderHsl`). */
  placeholderColors?: (tileset: TilesetPayload) => boolean;
}): TilemapChunkDraw[] {
  const { tiles, chunkSize, chunkX, chunkY, worldTileWidth, worldTileHeight, resolveGid, placeholderColors } = options;
  const atlases = new Map<string, { index: number; tileset: TilesetPayload; static: TilemapChunkDraw | null; animated: TilemapChunkDraw | null; colors: boolean }>();
  const order: string[] = [];
  const originX = chunkX * chunkSize;
  const originY = chunkY * chunkSize;
  for (let ly = 0; ly < chunkSize; ly++) {
    for (let lx = 0; lx < chunkSize; lx++) {
      const tileId = tiles[ly * chunkSize + lx] ?? 0;
      if (tileId <= 0) continue;
      const resolved = resolveGid(tileId);
      if (!resolved) continue;
      let atlas = atlases.get(resolved.guid);
      if (!atlas) {
        atlas = { index: order.length, tileset: resolved.tileset, static: null, animated: null, colors: placeholderColors?.(resolved.tileset) ?? false };
        atlases.set(resolved.guid, atlas);
        order.push(resolved.guid);
      }
      const meta = tilesetTileById(resolved.tileset, resolved.localId);
      const animated = (meta?.animation.length ?? 0) > 0;
      const uv = tilesetTileUv(resolved.tileset, meta ? tilesetAnimationFrame(resolved.tileset, meta, 0) : resolved.localId);
      if (!uv) continue;
      const kind: TilemapChunkDrawKind = animated ? "animated" : "static";
      let draw = atlas[kind];
      if (!draw) {
        draw = {
          guid: resolved.guid,
          atlasIndex: atlas.index,
          tileset: resolved.tileset,
          kind,
          data: atlas.colors
            ? { positions: [], uvs: [], indices: [], animatedTiles: [], colors: [] }
            : { positions: [], uvs: [], indices: [], animatedTiles: [] },
        };
        atlas[kind] = draw;
      }
      const data = draw.data;
      const x0 = (originX + lx) * worldTileWidth;
      const y0 = (originY + ly) * worldTileHeight;
      const x1 = (originX + lx + 1) * worldTileWidth;
      const y1 = (originY + ly + 1) * worldTileHeight;
      const base = data.positions.length / 3;
      data.positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
      if (animated && meta) data.animatedTiles.push({ uvOffset: data.uvs.length, tile: meta, tileset: resolved.tileset });
      data.uvs.push(uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1);
      if (data.colors) {
        const [r, g, b] = tilePlaceholderRgb(tileId);
        for (let corner = 0; corner < 4; corner++) data.colors.push(r, g, b, 1);
      }
      data.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const draws: TilemapChunkDraw[] = [];
  for (const guid of order) {
    const atlas = atlases.get(guid)!;
    if (atlas.static) draws.push(atlas.static);
    if (atlas.animated) draws.push(atlas.animated);
  }
  return draws;
}

export function tilemapChunkVertexData(options: {
  tiles: readonly number[];
  chunkSize: number;
  chunkX: number;
  chunkY: number;
  tileset: TilesetPayload;
  worldTileWidth: number;
  worldTileHeight: number;
  /** Omit to include every non-empty tile (golden / debug dumps). */
  kind?: TilemapChunkDrawKind;
  /** When set, GIDs are decoded before UV lookup. */
  resolveGid?: (
    gid: number,
  ) => { tileset: TilesetPayload; localId: number; guid: string } | null;
  /** With `resolveGid`, emit only tiles that belong to this tileset guid. */
  atlasGuid?: string;
  /** Emit a per-vertex `tilePlaceholderHsl` colour for an atlas without an image. */
  placeholderColors?: boolean;
}): TilemapChunkVertexData {
  const {
    tiles,
    chunkSize,
    chunkX,
    chunkY,
    tileset,
    worldTileWidth,
    worldTileHeight,
    kind,
    resolveGid,
    atlasGuid,
    placeholderColors,
  } = options;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const animatedTiles: TilemapChunkVertexData["animatedTiles"] = [];
  const originX = chunkX * chunkSize;
  const originY = chunkY * chunkSize;
  let quad = 0;
  for (let ly = 0; ly < chunkSize; ly++) {
    for (let lx = 0; lx < chunkSize; lx++) {
      const tileId = tiles[ly * chunkSize + lx] ?? 0;
      if (tileId <= 0) continue;
      const resolved = resolveGid?.(tileId);
      if (resolveGid && !resolved) continue;
      if (atlasGuid && resolved && resolved.guid !== atlasGuid) continue;
      const atlas = resolved?.tileset ?? tileset;
      const localId = resolved?.localId ?? tileId;
      const meta = tilesetTileById(atlas, localId);
      const animated = (meta?.animation.length ?? 0) > 0;
      if (kind === "static" && animated) continue;
      if (kind === "animated" && !animated) continue;
      const uvId = meta ? tilesetAnimationFrame(atlas, meta, 0) : localId;
      const uv = tilesetTileUv(atlas, uvId);
      if (!uv) continue;
      // Match the authored grid without stretching tiles into neighboring cells.
      // Identical grid boundaries use identical arithmetic across chunks.
      const x0 = (originX + lx) * worldTileWidth;
      const y0 = (originY + ly) * worldTileHeight;
      const x1 = (originX + lx + 1) * worldTileWidth;
      const y1 = (originY + ly + 1) * worldTileHeight;
      // Quad order matches sprite CreatePlane: BL, BR, TR, TL.
      positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
      if (animated && meta) animatedTiles.push({ uvOffset: uvs.length, tile: meta, tileset: atlas });
      uvs.push(uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1);
      if (placeholderColors) {
        const [r, g, b] = tilePlaceholderRgb(tileId);
        for (let corner = 0; corner < 4; corner++) colors.push(r, g, b, 1);
      }
      const base = quad * 4;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      quad += 1;
    }
  }
  return placeholderColors
    ? { positions, uvs, indices, animatedTiles, colors }
    : { positions, uvs, indices, animatedTiles };
}
