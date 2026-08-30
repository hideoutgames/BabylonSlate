import { tilesetTileById, tilesetTileUv, type TilesetPayload } from "./tileset-payload";

/** Babylon-free chunk geometry: one draw per chunk per atlas. */
export interface TilemapChunkVertexData {
  positions: number[];
  uvs: number[];
  indices: number[];
}

export type TilemapChunkDrawKind = "static" | "animated";

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
  } = options;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const originX = chunkX * chunkSize * worldTileWidth;
  const originY = chunkY * chunkSize * worldTileHeight;
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
      const uvId = animated ? (meta?.animation[0] ?? localId) : localId;
      const uv = tilesetTileUv(atlas, uvId);
      if (!uv) continue;
      // Interior quad is exact cell size (sprite 1:1). A 1-texel rim around it
      // clamps to the inset UV edge so zoom/pan cannot open a raster crack.
      const overlapX =
        atlas.tileWidth > 0 ? worldTileWidth / atlas.tileWidth : 0;
      const overlapY =
        atlas.tileHeight > 0 ? worldTileHeight / atlas.tileHeight : 0;
      const x0 = originX + lx * worldTileWidth;
      const y0 = originY + ly * worldTileHeight;
      const x1 = x0 + worldTileWidth;
      const y1 = y0 + worldTileHeight;
      const xs = [x0 - overlapX, x0, x1, x1 + overlapX];
      const ys = [y0 - overlapY, y0, y1, y1 + overlapY];
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const uu0 = i === 0 ? uv.u0 : i === 2 ? uv.u1 : uv.u0;
          const uu1 = i === 0 ? uv.u0 : i === 2 ? uv.u1 : uv.u1;
          const vv0 = j === 0 ? uv.v0 : j === 2 ? uv.v1 : uv.v0;
          const vv1 = j === 0 ? uv.v0 : j === 2 ? uv.v1 : uv.v1;
          positions.push(
            xs[i]!,
            ys[j]!,
            0,
            xs[i + 1]!,
            ys[j]!,
            0,
            xs[i + 1]!,
            ys[j + 1]!,
            0,
            xs[i]!,
            ys[j + 1]!,
            0,
          );
          uvs.push(uu0, vv0, uu1, vv0, uu1, vv1, uu0, vv1);
          const base = quad * 4;
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          quad += 1;
        }
      }
    }
  }
  return { positions, uvs, indices };
}

/** Local offset so a parallax of 1 stays in world space and 0 tracks the camera. */
export function tilemapParallaxOffset(
  parallax: { x: number; y: number },
  camera: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: camera.x * (1 - parallax.x),
    y: camera.y * (1 - parallax.y),
  };
}
