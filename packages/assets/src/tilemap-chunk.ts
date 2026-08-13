import { tilesetTileUv, type TilesetPayload } from "./tileset-payload";

/** Babylon-free chunk geometry: one draw per chunk per atlas. */
export interface TilemapChunkVertexData {
  positions: number[];
  uvs: number[];
  indices: number[];
}

export function tilemapChunkVertexData(options: {
  tiles: readonly number[];
  chunkSize: number;
  chunkX: number;
  chunkY: number;
  tileset: TilesetPayload;
  worldTileWidth: number;
  worldTileHeight: number;
}): TilemapChunkVertexData {
  const {
    tiles,
    chunkSize,
    chunkX,
    chunkY,
    tileset,
    worldTileWidth,
    worldTileHeight,
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
      const uv = tilesetTileUv(tileset, tileId);
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
