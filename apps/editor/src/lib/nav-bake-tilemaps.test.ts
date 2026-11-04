import { describe, expect, it } from "vitest";
import { emptyChunkTiles, normalizeTilemapPayload, normalizeTilesetPayload } from "@haptic/assets";
import { createActor, type SerializedTransform } from "@haptic/core";
import { navBakeTilemapChains } from "./nav-bake-tilemaps";

/** A map whose only collision is one Full tile at cell 0, 0: a 1 × 1 square at 16 px per unit. */
function oneTileMap() {
  const tiles = emptyChunkTiles(2);
  tiles[0] = 1;
  return normalizeTilemapPayload({
    tilesets: [{ guid: "set", firstGid: 1, tileCount: 1 }],
    tileWidth: 16,
    tileHeight: 16,
    chunkSize: 2,
    layers: [{ id: "ground", collision: true, chunks: [{ cx: 0, cy: 0, tiles }] }],
  });
}

const TILESETS = new Map([["set", normalizeTilesetPayload({ tiles: [{ id: 1, collision: "full" }] })]]);
const TILEMAPS = new Map([["map", oneTileMap()]]);

const transform = (position: [number, number, number], rotation: [number, number, number, number] = [0, 0, 0, 1], scale: [number, number, number] = [1, 1, 1]): SerializedTransform =>
  ({ position, rotation, scale });

function tilemapActor(id: string, actorTransform: SerializedTransform, extra: Partial<ReturnType<typeof createActor>> = {}) {
  return {
    ...createActor(id, id, {
      transform: actorTransform,
      components: [{ id: `${id}-map`, classId: "TilemapComponent", properties: { assetGuid: "map" } }],
    }),
    ...extra,
  };
}

/** Each chain's corners, sorted, rounded against float noise. */
const corners = (chains: ReturnType<typeof navBakeTilemapChains>) =>
  chains.map((chain) => chain.points.map(({ x, y }) => [Math.round(x * 1e6) / 1e6 + 0, Math.round(y * 1e6) / 1e6 + 0]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));

describe("navBakeTilemapChains", () => {
  it("bakes each Tilemap actor's walls where the actor puts them: moved, scaled, turned and parented", () => {
    const scene = {
      actors: [
        tilemapActor("moved", transform([10, 5, 0], [0, 0, 0, 1], [2, 3, 1])),
        // Half a turn about Z sends (x, y) to (-x, -y).
        tilemapActor("turned", transform([0, 0, 0], [0, 0, 1, 0])),
        createActor("parent", "Parent", { transform: transform([100, 0, 0], [0, 0, 0, 1], [2, 2, 1]) }),
        tilemapActor("child", transform([1, 1, 0]), { parentId: "parent" }),
        createActor("other", "Other"),
      ],
    };
    const chains = navBakeTilemapChains(scene, TILEMAPS, TILESETS, 16);
    expect(chains.every((chain) => chain.loop)).toBe(true);
    expect(corners(chains)).toEqual([
      [[10, 5], [10, 8], [12, 5], [12, 8]],
      [[-1, -1], [-1, 0], [0, -1], [0, 0]],
      // The child's offset is in the parent's scaled space: at 102, 2, and twice the size.
      [[102, 2], [102, 4], [104, 2], [104, 4]],
    ]);
  });

  it("adds the Tilemap component's own transform, and skips maps without Tilesets", () => {
    const actor = tilemapActor("offset", transform([0, 0, 0]));
    actor.components[0]!.transform = transform([0, -4, 0], [0, 0, 0, 1], [1, 2, 1]);
    const bare = new Map([["map", normalizeTilemapPayload({ ...oneTileMap(), tilesets: [] })]]);
    expect(corners(navBakeTilemapChains({ actors: [actor] }, TILEMAPS, TILESETS, 16))).toEqual([[[0, -4], [0, -2], [1, -4], [1, -2]]]);
    expect(navBakeTilemapChains({ actors: [actor] }, bare, TILESETS, 16)).toEqual([]);
  });
});
