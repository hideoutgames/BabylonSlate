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
      const meta = tilesetTileById(tileset, tileId);
      const animated = (meta?.animation.length ?? 0) > 0;
      if (kind === "static" && animated) continue;
      if (kind === "animated" && !animated) continue;
      const uvId = animated ? (meta?.animation[0] ?? tileId) : tileId;
      const uv = tilesetTileUv(tileset, uvId);
      if (!uv) continue;
      const x0 = originX + lx * worldTileWidth;
      const y0 = originY + ly * worldTileHeight;
      const x1 = x0 + worldTileWidth;
      const y1 = y0 + worldTileHeight;
      // Quad order matches sprite CreatePlane: BL, BR, TR, TL.
      positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
      uvs.push(uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1);
      const base = quad * 4;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      quad += 1;
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
