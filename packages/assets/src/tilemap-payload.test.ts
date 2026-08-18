import { describe, expect, it } from "vitest";
import { ensureTilesetTiles, normalizeTilesetPayload } from "./tileset-payload";
import {
  addTilemapLayer,
  addTilemapTileset,
  chunkCoordForTile,
  createDefaultTilemapPayload,
  decodeTileGid,
  emptyChunkTiles,
  encodeTileGid,
  getTile,
  localIndex,
  normalizeTilemapPayload,
  removeTilemapTileset,
  reorderTilemapLayers,
  resizeTilemap,
  setTile,
  tilemapTilesetGuids,
} from "./tilemap-payload";

describe("tilemap payload", () => {
  it("defaults to one collision layer, 32-tile chunks, and a 64×64 map", () => {
    const payload = createDefaultTilemapPayload();
    expect(payload.tilesetGuid).toBeNull();
    expect(payload.tileWidth).toBe(16);
    expect(payload.tileHeight).toBe(16);
    expect(payload.width).toBe(64);
    expect(payload.height).toBe(64);
    expect(payload.chunkSize).toBe(32);
    expect(payload.layers[0]?.chunks).toEqual([]);
    expect(payload.layers).toHaveLength(1);
    expect(payload.layers[0]).toMatchObject({
      id: "layer-1",
      name: "Ground",
      visible: true,
      collision: true,
      sortingLayer: "Default",
      orderInLayer: 0,
      parallax: { x: 1, y: 1 },
      chunks: [],
    });
    expect(emptyChunkTiles(32)).toHaveLength(1024);
    expect(emptyChunkTiles(32).every((id) => id === 0)).toBe(true);
  });

  it("indexes local tiles with (0,0) at the chunk bottom-left", () => {
    expect(localIndex(0, 0, 32)).toBe(0);
    expect(localIndex(1, 0, 32)).toBe(1);
    expect(localIndex(0, 1, 32)).toBe(32);
  });

  it("maps world tiles onto chunks, including negatives", () => {
    expect(chunkCoordForTile(0, 0, 32)).toEqual({ cx: 0, cy: 0, lx: 0, ly: 0 });
    expect(chunkCoordForTile(32, 31, 32)).toEqual({
      cx: 1,
      cy: 0,
      lx: 0,
      ly: 31,
    });
    expect(chunkCoordForTile(-1, -1, 32)).toEqual({
      cx: -1,
      cy: -1,
      lx: 31,
      ly: 31,
    });
  });

  it("sets and reads tiles, creating only the affected chunk", () => {
    let map = createDefaultTilemapPayload();
    map = setTile(map, "layer-1", 1, 2, 7);
    expect(getTile(map, "layer-1", 1, 2)).toBe(7);
    expect(getTile(map, "layer-1", 0, 0)).toBe(0);
    expect(map.layers[0]?.chunks).toHaveLength(1);
    expect(map.layers[0]?.chunks[0]).toMatchObject({ cx: 0, cy: 0 });
  });

  it("ignores setTile outside the map rectangle", () => {
    let map = createDefaultTilemapPayload();
    const before = map;
    map = setTile(map, "layer-1", 64, 0, 7);
    map = setTile(map, "layer-1", 0, 64, 7);
    map = setTile(map, "layer-1", -1, 0, 7);
    expect(map).toBe(before);
    expect(getTile(map, "layer-1", 64, 0)).toBe(0);
    expect(map.layers[0]?.chunks).toEqual([]);
  });

  it("migrates missing size to max(64, painted AABB + 1)", () => {
    const empty = normalizeTilemapPayload({ layers: [] });
    expect(empty.width).toBe(64);
    expect(empty.height).toBe(64);
    const tiles = emptyChunkTiles(32);
    tiles[localIndex(6, 0, 32)] = 3;
    const painted = normalizeTilemapPayload({
      chunkSize: 32,
      layers: [{ id: "layer-1", chunks: [{ cx: 2, cy: 1, tiles }] }],
    });
    expect(painted.width).toBe(71);
    expect(painted.height).toBe(64);
    expect(getTile(painted, "layer-1", 70, 32)).toBe(3);
  });

  it("clips tiles and drops empty chunks when the map shrinks", () => {
    let map = createDefaultTilemapPayload();
    map = setTile(map, "layer-1", 0, 0, 4);
    map = setTile(map, "layer-1", 5, 1, 9);
    map = resizeTilemap(map, 4, 4);
    expect(map.width).toBe(4);
    expect(map.height).toBe(4);
    expect(getTile(map, "layer-1", 0, 0)).toBe(4);
    expect(getTile(map, "layer-1", 5, 1)).toBe(0);
    expect(map.layers[0]?.chunks).toHaveLength(1);
    map = resizeTilemap(map, 0, -3);
    expect(map.width).toBe(1);
    expect(map.height).toBe(1);
  });

  it("normalizes missing layers and clamps chunk size", () => {
    const payload = normalizeTilemapPayload({
      chunkSize: 0,
      layers: [{ name: "BG", chunks: [{ cx: 0, cy: 0, tiles: [1] }] }],
    });
    expect(payload.chunkSize).toBe(32);
    expect(payload.layers[0]?.id).toBeTruthy();
    expect(payload.layers[0]?.chunks[0]?.tiles).toHaveLength(32 * 32);
    expect(payload.layers[0]?.chunks[0]?.tiles[0]).toBe(1);
  });

  it("preserves explicit false visibility/collision and coerces layer fields", () => {
    const payload = normalizeTilemapPayload({
      layers: [
        {
          id: "bg",
          name: "Background",
          visible: false,
          collision: false,
          sortingLayer: "   ",
          orderInLayer: "nope",
          parallax: { x: "bad", y: 0.5 },
        },
        {
          name: "FG",
          parallax: null,
          orderInLayer: 3,
        },
      ],
    });
    expect(payload.layers[0]).toMatchObject({
      id: "bg",
      visible: false,
      collision: false,
      sortingLayer: "Default",
      orderInLayer: 0,
      parallax: { x: 1, y: 0.5 },
    });
    expect(payload.layers[1]).toMatchObject({
      id: "layer-2",
      name: "FG",
      visible: true,
      collision: true,
      orderInLayer: 3,
      parallax: { x: 1, y: 1 },
    });
  });

  it("adds and reorders named layers without dropping chunks", () => {
    let map = createDefaultTilemapPayload();
    map = setTile(map, "layer-1", 0, 0, 3);
    map = addTilemapLayer(map, "Foreground");
    expect(map.layers).toHaveLength(2);
    expect(map.layers[1]?.name).toBe("Foreground");
    expect(map.layers[1]?.id).not.toBe("layer-1");
    expect(map.layers[1]?.visible).toBe(true);
    expect(map.layers[1]?.collision).toBe(true);
    const ids = map.layers.map((layer) => layer.id);
    map = reorderTilemapLayers(map, [ids[1]!, ids[0]!]);
    expect(map.layers.map((layer) => layer.name)).toEqual(["Foreground", "Ground"]);
    expect(getTile(map, "layer-1", 0, 0)).toBe(3);
  });

  it("migrates a legacy tilesetGuid into a firstGid-1 tileset list", () => {
    const payload = normalizeTilemapPayload({
      tilesetGuid: "ground",
    });
    expect(payload.tilesetGuid).toBe("ground");
    expect(payload.tilesets).toEqual([
      { guid: "ground", firstGid: 1, tileCount: 0 },
    ]);
    expect(tilemapTilesetGuids(payload)).toEqual(["ground"]);
  });

  it("keeps tilesetGuid as an alias of the first listed tileset", () => {
    const payload = normalizeTilemapPayload({
      tilesets: [
        { guid: "a", firstGid: 1, tileCount: 8 },
        { guid: "b", firstGid: 9, tileCount: 4 },
      ],
    });
    expect(payload.tilesetGuid).toBe("a");
    expect(tilemapTilesetGuids(payload)).toEqual(["a", "b"]);
  });

  it("encodes and decodes Tiled-style GIDs without compacting on remove", () => {
    const ground = ensureTilesetTiles(
      normalizeTilesetPayload({
        atlasWidth: 32,
        atlasHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
      }),
    );
    const deco = ensureTilesetTiles(
      normalizeTilesetPayload({
        atlasWidth: 16,
        atlasHeight: 16,
        tileWidth: 16,
        tileHeight: 16,
      }),
    );
    const payloads = new Map([
      ["ground", ground],
      ["deco", deco],
    ]);
    let map = addTilemapTileset(createDefaultTilemapPayload(), "ground", ground);
    map = addTilemapTileset(map, "deco", deco);
    expect(map.tilesets).toEqual([
      { guid: "ground", firstGid: 1, tileCount: 2 },
      { guid: "deco", firstGid: 3, tileCount: 1 },
    ]);
    expect(encodeTileGid(1, 2)).toBe(2);
    expect(encodeTileGid(3, 1)).toBe(3);
    expect(decodeTileGid(map, 2, payloads)).toEqual({
      guid: "ground",
      localId: 2,
      tileset: ground,
    });
    expect(decodeTileGid(map, 3, payloads)).toEqual({
      guid: "deco",
      localId: 1,
      tileset: deco,
    });
    map = removeTilemapTileset(map, "ground");
    expect(map.tilesets).toEqual([{ guid: "deco", firstGid: 3, tileCount: 1 }]);
    expect(map.tilesetGuid).toBe("deco");
    expect(decodeTileGid(map, 3, payloads)?.guid).toBe("deco");
    expect(decodeTileGid(map, 1, payloads)).toBeNull();
  });
});
