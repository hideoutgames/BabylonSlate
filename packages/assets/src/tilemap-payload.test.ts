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
  rechunkTilemap,
  removeTilemapTileset,
  reorderTilemapLayers,
  resizeTilemap,
  setTile,
  setTiles,
  TilemapChunkIndex,
  tilemapCellKey,
  tilemapTilesetGuids,
  type TilemapPayload,
} from "./tilemap-payload";

describe("tilemap payload", () => {
  it("defaults to one collision layer, 32-tile chunks, and a 64×64 map", () => {
    const payload = createDefaultTilemapPayload();
    expect(payload.tilesets).toEqual([]);
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

  it("returns a normalized payload as itself and keeps every untouched layer, chunk and tiles array", () => {
    let map = setTile(setTile(createDefaultTilemapPayload(), "layer-1", 0, 0, 3), "layer-1", 40, 0, 4);
    map = addTilemapLayer(map, "Props");
    const normalized = normalizeTilemapPayload(map);
    expect(normalized).toBe(map);
    // A painted cell copies its chunk only; the rest of the map keeps its identity.
    const painted = setTile(normalized, "layer-1", 1, 0, 5);
    const again = normalizeTilemapPayload(painted);
    expect(again).toBe(painted);
    expect(again.layers[1]).toBe(map.layers[1]);
    expect(again.layers[0]!.chunks[1]).toBe(map.layers[0]!.chunks[1]);
    expect(again.layers[0]!.chunks[0]!.tiles).not.toBe(map.layers[0]!.chunks[0]!.tiles);
    // Anything the stored form does not hold exactly is rebuilt.
    const short = { ...map, layers: [{ ...map.layers[0]!, chunks: [{ cx: 0, cy: 0, tiles: [3] }] }] };
    const fixed = normalizeTilemapPayload(short);
    expect(fixed).not.toBe(short);
    expect(fixed.layers[0]!.chunks[0]!.tiles).toHaveLength(32 * 32);
    const extra = normalizeTilemapPayload({ ...map, stale: true });
    expect(extra).not.toHaveProperty("stale");
    expect(extra.layers).toBe(map.layers);
  });

  it("re-cuts every layer on a new chunk size without moving or losing a cell", () => {
    let map: TilemapPayload = { ...createDefaultTilemapPayload(), chunkSize: 4, width: 10, height: 10 };
    map = addTilemapLayer(map, "Props");
    for (const [layer, x, y, gid] of [
      ["layer-1", 0, 0, 1], ["layer-1", 3, 3, 2], ["layer-1", 4, 0, 3], ["layer-1", 9, 9, 4], ["layer-2", 5, 6, 5],
    ] as const) map = setTile(map, layer, x, y, gid);
    const rechunked = rechunkTilemap(map, 3);
    expect(rechunked.chunkSize).toBe(3);
    expect(rechunked.layers.map((layer) => layer.chunks.map((chunk) => [chunk.cx, chunk.cy]))).toEqual([
      [[0, 0], [1, 0], [1, 1], [3, 3]],
      [[1, 2]],
    ]);
    for (const chunk of rechunked.layers.flatMap((layer) => layer.chunks)) expect(chunk.tiles).toHaveLength(9);
    const cells = (target: TilemapPayload) => [
      getTile(target, "layer-1", 0, 0), getTile(target, "layer-1", 3, 3), getTile(target, "layer-1", 4, 0),
      getTile(target, "layer-1", 9, 9), getTile(target, "layer-2", 5, 6), getTile(target, "layer-1", 1, 1),
    ];
    expect(cells(rechunked)).toEqual([1, 2, 3, 4, 5, 0]);
    expect(cells(rechunkTilemap(rechunked, 32))).toEqual([1, 2, 3, 4, 5, 0]);
    expect(rechunkTilemap(map, 4)).toBe(map);
    // The new size is a whole number of at least 1, as normalizing would store it.
    expect(rechunkTilemap(map, 0).chunkSize).toBe(1);
    expect(cells(rechunkTilemap(map, 0))).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it("keys cells by number, negative coordinates included", () => {
    const keys = new Set<number>();
    for (const x of [-3, -1, 0, 1, 1000]) for (const y of [-2, 0, 7, 999]) keys.add(tilemapCellKey(x, y));
    expect(keys.size).toBe(20);
    expect(tilemapCellKey(-1, 0)).not.toBe(tilemapCellKey(0, -1));
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

  it("lists each tileset of the tileset list once", () => {
    const payload = normalizeTilemapPayload({
      tilesets: [
        { guid: "a", firstGid: 1, tileCount: 8 },
        { guid: "b", firstGid: 9, tileCount: 4 },
        { guid: "a", firstGid: 13, tileCount: 2 },
      ],
    });
    expect(tilemapTilesetGuids(payload)).toEqual(["a", "b"]);
  });

  it("keeps a Tileset ref's terrain stamp only when it is a non-empty string", () => {
    const payload = normalizeTilemapPayload({
      tilesets: [
        { guid: "a", firstGid: 1, tileCount: 8, terrainStamp: "1a2b3c4d" },
        { guid: "b", firstGid: 9, tileCount: 4, terrainStamp: "" },
        { guid: "c", firstGid: 13, tileCount: 2, terrainStamp: 7 },
      ],
    });
    expect(payload.tilesets).toEqual([
      { guid: "a", firstGid: 1, tileCount: 8, terrainStamp: "1a2b3c4d" },
      { guid: "b", firstGid: 9, tileCount: 4 },
      { guid: "c", firstGid: 13, tileCount: 2 },
    ]);
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
    const ranges = (refs: TilemapPayload["tilesets"]) => refs.map(({ guid, firstGid, tileCount }) => ({ guid, firstGid, tileCount }));
    let map = addTilemapTileset(createDefaultTilemapPayload(), "ground", ground);
    map = addTilemapTileset(map, "deco", deco);
    expect(ranges(map.tilesets)).toEqual([
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
    expect(ranges(map.tilesets)).toEqual([{ guid: "deco", firstGid: 3, tileCount: 1 }]);
    expect(decodeTileGid(map, 3, payloads)?.guid).toBe("deco");
    expect(decodeTileGid(map, 1, payloads)).toBeNull();
  });

  it("erases a removed tileset across layers before its GIDs can be reused", () => {
    const tileset = ensureTilesetTiles(normalizeTilesetPayload({
      atlasWidth: 32, atlasHeight: 16, tileWidth: 16, tileHeight: 16,
    }));
    let map = addTilemapTileset(createDefaultTilemapPayload(), "ground", tileset);
    map = addTilemapTileset(map, "props", tileset);
    map = addTilemapLayer(map);
    map = setTile(map, "layer-1", 0, 0, 1);
    map = setTile(map, "layer-1", 1, 0, 3);
    const hiddenId = map.layers[1]!.id;
    map = setTile(map, hiddenId, 0, 0, 4);
    map.layers[1] = { ...map.layers[1]!, visible: false };
    const removed = removeTilemapTileset(map, "props");
    expect(getTile(removed, "layer-1", 0, 0)).toBe(1);
    expect(getTile(removed, "layer-1", 1, 0)).toBe(0);
    expect(removed.layers[1]?.chunks).toEqual([]);
    expect(getTile(map, "layer-1", 1, 0)).toBe(3);
    expect(getTile(map, hiddenId, 0, 0)).toBe(4);
    const replacement = addTilemapTileset(removed, "replacement", tileset);
    expect(replacement.tilesets[1]?.firstGid).toBe(3);
    expect(getTile(replacement, "layer-1", 1, 0)).toBe(0);
  });

  it("leaves a map unchanged when the removed tileset is not listed", () => {
    const map = setTile(createDefaultTilemapPayload(), "layer-1", 0, 0, 1);
    expect(removeTilemapTileset(map, "missing")).toBe(map);
  });
});

describe("setTiles with a chunk index", () => {
  const cells = (list: Array<[number, number, number]>) =>
    list.map(([x, y, id]) => ({ x, y, id }));
  const small = (): TilemapPayload => ({ ...createDefaultTilemapPayload(), chunkSize: 4 });
  const order = (map: TilemapPayload) =>
    map.layers[0]!.chunks.map((chunk) => `${chunk.cx},${chunk.cy}`);

  it("follows a stroke's writes with the chunk order and no-op results of plain writes", () => {
    const strokes: Array<Array<[number, number, number]>> = [
      [[0, 0, 1], [5, 0, 2]],
      [[9, 9, 3]],
      [[0, 0, 1]],
      [[5, 0, 0]],
      [[6, 1, 4]],
      [[0, 1, 5], [9, 9, 0]],
    ];
    const index = new TilemapChunkIndex(true);
    let plain = small();
    let indexed = small();
    const orders: string[][] = [];
    for (const stroke of strokes) {
      const previous = indexed;
      plain = setTiles(plain, "layer-1", cells(stroke));
      indexed = setTiles(indexed, "layer-1", cells(stroke), index);
      expect(indexed).toEqual(plain);
      // A write that changes nothing hands back the map it was given.
      if (stroke === strokes[2]) expect(indexed).toBe(previous);
      orders.push(order(indexed));
    }
    // A dropped chunk that is painted again joins the end, as with plain writes.
    expect(orders).toEqual([
      ["0,0", "1,0"],
      ["0,0", "1,0", "2,2"],
      ["0,0", "1,0", "2,2"],
      ["0,0", "2,2"],
      ["0,0", "2,2", "1,0"],
      ["0,0", "1,0"],
    ]);
  });

  it("re-derives from one base without earlier calls leaking in", () => {
    const base = setTiles(small(), "layer-1", cells([[0, 0, 1], [5, 0, 2]]));
    const index = new TilemapChunkIndex();
    for (const stroke of [
      [[9, 9, 3]],
      [[9, 9, 3], [5, 0, 0]],
      [[1, 0, 7]],
      [[9, 9, 3]],
    ] as Array<Array<[number, number, number]>>) {
      expect(setTiles(base, "layer-1", cells(stroke), index)).toEqual(
        setTiles(base, "layer-1", cells(stroke)),
      );
    }
    expect(order(base)).toEqual(["0,0", "1,0"]);
    expect(getTile(base, "layer-1", 5, 0)).toBe(2);
  });

  it("rebuilds when handed a map other than the one it describes", () => {
    const index = new TilemapChunkIndex(true);
    setTiles(small(), "layer-1", cells([[0, 0, 1]]), index);
    const other = setTiles(small(), "layer-1", cells([[9, 9, 2], [0, 5, 3]]));
    const erase = cells([[9, 9, 0]]);
    expect(setTiles(other, "layer-1", erase, index)).toEqual(setTiles(other, "layer-1", erase));
    expect(setTiles(other, "layer-1", erase, index).layers[0]!.chunks).toHaveLength(1);
  });

  it("matches plain writes on a layer that repeats a chunk", () => {
    const first = setTiles(small(), "layer-1", cells([[0, 0, 1]])).layers[0]!.chunks[0]!;
    const repeated = { ...first, tiles: first.tiles.map((id) => (id > 0 ? 2 : id)) };
    const map = { ...small(), layers: [{ ...small().layers[0]!, chunks: [first, repeated] }] };
    const write = cells([[1, 0, 5]]);
    expect(setTiles(map, "layer-1", write, new TilemapChunkIndex(true))).toEqual(
      setTiles(map, "layer-1", write),
    );
  });
});
