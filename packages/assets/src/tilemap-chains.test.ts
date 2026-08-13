import { describe, expect, it } from "vitest";
import { tilemapChunkChains } from "./tilemap-chains";
import { emptyChunkTiles } from "./tilemap-payload";
import { normalizeTilesetPayload } from "./tileset-payload";

function fullTileset() {
  return normalizeTilesetPayload({
    tiles: [
      { id: 1, collision: "full" },
      { id: 2, collision: "none" },
      {
        id: 3,
        collision: {
          kind: "chain",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      },
    ],
  });
}

describe("tilemapChunkChains", () => {
  it("merges two adjacent solid tiles into one outer loop", () => {
    const tiles = emptyChunkTiles(2);
    tiles[0] = 1;
    tiles[1] = 1;
    const chains = tilemapChunkChains({
      tiles,
      chunkSize: 2,
      chunkX: 0,
      chunkY: 0,
      tileset: fullTileset(),
      worldTileWidth: 1,
      worldTileHeight: 1,
    });
    expect(chains).toHaveLength(1);
    expect(chains[0]?.loop).toBe(true);
    const points = chains[0]?.points ?? [];
    expect(points.length).toBeGreaterThanOrEqual(4);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(2);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(1);
  });

  it("cancels the shared edge so a 2x2 solid block has no internal vertices", () => {
    const tiles = emptyChunkTiles(2);
    tiles[0] = 1;
    tiles[1] = 1;
    tiles[2] = 1;
    tiles[3] = 1;
    const chains = tilemapChunkChains({
      tiles,
      chunkSize: 2,
      chunkX: 0,
      chunkY: 0,
      tileset: fullTileset(),
      worldTileWidth: 1,
      worldTileHeight: 1,
    });
    expect(chains).toHaveLength(1);
    expect(chains[0]?.loop).toBe(true);
    expect(chains[0]?.points).toHaveLength(4);
  });

  it("skips empty and non-colliding tiles", () => {
    const tiles = emptyChunkTiles(2);
    tiles[0] = 2;
    tiles[1] = 0;
    expect(
      tilemapChunkChains({
        tiles,
        chunkSize: 2,
        chunkX: 0,
        chunkY: 0,
        tileset: fullTileset(),
        worldTileWidth: 1,
        worldTileHeight: 1,
      }),
    ).toEqual([]);
  });

  it("emits custom chain points in tile-local 0-1 space, scaled to the world tile", () => {
    const tiles = emptyChunkTiles(2);
    tiles[0] = 3;
    const chains = tilemapChunkChains({
      tiles,
      chunkSize: 2,
      chunkX: 1,
      chunkY: 0,
      tileset: fullTileset(),
      worldTileWidth: 2,
      worldTileHeight: 2,
    });
    expect(chains).toEqual([
      {
        loop: false,
        points: [
          { x: 4, y: 0 },
          { x: 6, y: 0 },
          { x: 6, y: 2 },
        ],
      },
    ]);
  });
});
