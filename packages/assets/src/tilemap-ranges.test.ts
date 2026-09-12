import { describe, expect, it } from "vitest";
import { normalizeTilesetPayload } from "./tileset-payload";
import {
  addTilemapTileset,
  decodeTileGid,
  normalizeTilemapPayload,
  reconcileTilemapTilesets,
  tilemapTileIdentity,
} from "./tilemap-payload";

const atlas = (count: number) =>
  normalizeTilesetPayload({ atlasWidth: count * 16, atlasHeight: 16 });
const mapWith = (tiles: number[], firstB = 3) =>
  normalizeTilemapPayload({
    chunkSize: 2,
    tilesets: [
      { guid: "a", firstGid: 1, tileCount: 2 },
      { guid: "b", firstGid: firstB, tileCount: 2 },
    ],
    layers: [
      { id: "visible", chunks: [{ cx: 0, cy: 0, tiles }] },
      { id: "hidden", visible: false, chunks: [{ cx: 1, cy: 0, tiles }] },
    ],
  });

describe("Tilemap Tileset reservations", () => {
  it("relocates a grown atlas and preserves both painted identities on every layer", () => {
    const map = mapWith([1, 2, 3, 4]);
    const before = structuredClone(map);
    const atlases = new Map([
      ["a", atlas(4)],
      ["b", atlas(2)],
    ]);
    const next = reconcileTilemapTilesets(map, atlases);
    expect(next.tilesets).toEqual([
      { guid: "a", firstGid: 5, tileCount: 4 },
      { guid: "b", firstGid: 3, tileCount: 2 },
    ]);
    for (const layer of next.layers) {
      expect(layer.chunks[0]!.tiles).toEqual([5, 6, 3, 4]);
      expect(
        layer.chunks[0]!.tiles.map((gid) => tilemapTileIdentity(next, gid)),
      ).toEqual([
        { guid: "a", localId: 1 },
        { guid: "a", localId: 2 },
        { guid: "b", localId: 1 },
        { guid: "b", localId: 2 },
      ]);
    }
    expect(decodeTileGid(next, 7, atlases)).toMatchObject({
      guid: "a",
      localId: 3,
    });
    expect(map).toEqual(before);
    expect(reconcileTilemapTilesets(next, atlases)).toBe(next);
  });

  it("uses an available gap without moving painted cells", () => {
    const map = mapWith([1, 2, 10, 11], 10);
    const next = reconcileTilemapTilesets(map, new Map([["a", atlas(8)]]));
    expect(next.tilesets[0]).toEqual({ guid: "a", firstGid: 1, tileCount: 8 });
    expect(next.layers).toBe(map.layers);
    expect(next.tilesets[1]).toEqual(map.tilesets[1]);
  });

  it("does not claim orphaned painted GIDs while expanding a gap", () => {
    const map = mapWith([1, 5, 10, 11], 10);
    const next = reconcileTilemapTilesets(map, new Map([["a", atlas(8)]]));
    expect(next.tilesets[0]!.firstGid).toBe(12);
    expect(next.layers[0]!.chunks[0]!.tiles).toEqual([12, 5, 10, 11]);
    expect(tilemapTileIdentity(next, 5)).toBeNull();
  });

  it("preserves missing local tiles through shrink, missing assets and regrowth", () => {
    const map = mapWith([2, 0, 3, 0]);
    expect(reconcileTilemapTilesets(map, new Map([["a", atlas(1)]]))).toBe(map);
    expect(tilemapTileIdentity(map, 2)).toEqual({ guid: "a", localId: 2 });
    expect(decodeTileGid(map, 2, new Map([["a", atlas(1)]]))).toBeNull();
    expect(decodeTileGid(map, 2, new Map([["b", atlas(2)]]))).toBeNull();
    expect(decodeTileGid(map, 2, new Map([["a", atlas(2)]]))).toMatchObject({
      guid: "a",
      localId: 2,
    });
  });

  it("bounds legacy ownership by saved ranges and preserves the last painted local ID", () => {
    const map = mapWith([2, 12, 0, 0]);
    map.tilesets.forEach((ref) => {
      ref.tileCount = 0;
    });
    const next = reconcileTilemapTilesets(
      map,
      new Map([
        ["a", atlas(4)],
        ["b", atlas(1)],
      ]),
    );
    expect(next.tilesets).toEqual([
      { guid: "a", firstGid: 13, tileCount: 4 },
      { guid: "b", firstGid: 3, tileCount: 10 },
    ]);
    expect(next.layers[0]!.chunks[0]!.tiles).toEqual([14, 12, 0, 0]);
    expect(tilemapTileIdentity(next, 12)).toEqual({ guid: "b", localId: 10 });
  });

  it("allocates additions after unknown painted IDs and legacy atlas capacity", () => {
    const map = normalizeTilemapPayload({
      tilesetGuid: "a",
      chunkSize: 2,
      layers: [{ chunks: [{ cx: 0, cy: 0, tiles: [4, 0, 0, 0] }] }],
    });
    const next = addTilemapTileset(
      map,
      "b",
      atlas(2),
      new Map([["a", atlas(8)]]),
    );
    expect(next.tilesets).toEqual([
      { guid: "a", firstGid: 1, tileCount: 8 },
      { guid: "b", firstGid: 9, tileCount: 2 },
    ]);
    expect(next.layers[0]!.chunks[0]!.tiles[0]).toBe(4);
    expect(
      addTilemapTileset(mapWith([1, 2, 3, 20]), "c", atlas(2)).tilesets[2]!
        .firstGid,
    ).toBe(21);
  });
});
