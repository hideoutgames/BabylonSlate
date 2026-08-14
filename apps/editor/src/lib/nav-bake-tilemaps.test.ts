import { describe, expect, it } from "vitest";
import { emptyChunkTiles, normalizeTilemapPayload } from "@babylonslate/assets";
import { normalizeTilesetPayload } from "@babylonslate/assets";
import { navBakeTilemapChains } from "./nav-bake-tilemaps";

describe("navBakeTilemapChains", () => {
  it("emits Recast wall chains from collision layers", () => {
    const tiles = emptyChunkTiles(2);
    tiles[0] = 1;
    const tilemaps = new Map([
      [
        "map",
        normalizeTilemapPayload({
          tilesetGuid: "set",
          tileWidth: 16,
          tileHeight: 16,
          chunkSize: 2,
          layers: [
            {
              id: "ground",
              collision: true,
              chunks: [{ cx: 0, cy: 0, tiles }],
            },
          ],
        }),
      ],
    ]);
    const tilesets = new Map([
      [
        "set",
        normalizeTilesetPayload({
          tiles: [{ id: 1, collision: "full" }],
        }),
      ],
    ]);
    const chains = navBakeTilemapChains(tilemaps, tilesets, 16);
    expect(chains.length).toBeGreaterThan(0);
    expect(chains[0]?.points.length).toBeGreaterThan(1);
  });
});
