import { describe, expect, it } from "vitest";
import { TERRAIN_E, TERRAIN_W, tilesetTerrainStamp } from "./tileset-terrain";
import { ensureTilesetTiles, normalizeTilesetPayload } from "./tileset-payload";
import {
  createDefaultTilemapPayload,
  createTilemapLayer,
  getTile,
  setTiles,
  TILEMAP_CELL_LIMIT,
  type TilemapPayload,
} from "./tilemap-payload";
import {
  clampTilemapCellRect,
  copyTilemapCells,
  eraseTilemapCells,
  moveTilemapCells,
  placeTilemapClip,
  retargetTilemapClip,
  tilemapClipLostTiles,
  tilemapClipTileCount,
  tilemapSelectionExtent,
} from "./tilemap-selection";

/** A bounded map of `width` × `height` with layers "a" and "b", chunks of 4 so blocks cross chunk borders. */
function twoLayerMap(width = 12, height = 6): TilemapPayload {
  return {
    ...createDefaultTilemapPayload(),
    tilesets: [{ guid: "ts", firstGid: 1, tileCount: 9 }],
    width,
    height,
    chunkSize: 4,
    layers: [createTilemapLayer("a", "A"), createTilemapLayer("b", "B")],
  };
}

/** Paint rows drawn top to bottom from `top`, starting at column `left`: digits are GIDs, `.` is empty. */
function paint(map: TilemapPayload, layerId: string, rows: readonly string[], left = 0, top = rows.length - 1): TilemapPayload {
  const writes = rows.flatMap((row, at) => [...row].map((char, x) => ({ x: left + x, y: top - at, id: char === "." ? 0 : Number(char) })));
  return setTiles(map, layerId, writes);
}

/** One layer's cells `left`..`left + width - 1` × `bottom`..`top`, drawn top to bottom. */
function draw(map: TilemapPayload, layerId: string, { left = 0, width = 12, bottom = 0, top = 5 } = {}): string[] {
  const rows: string[] = [];
  for (let y = top; y >= bottom; y--) {
    let row = "";
    for (let x = left; x < left + width; x++) {
      const gid = getTile(map, layerId, x, y);
      row += gid === 0 ? "." : String(gid);
    }
    rows.push(row);
  }
  return rows;
}

describe("tilemap selection rects", () => {
  it("clamps a rect given by any two corners to the map, and none outside it", () => {
    const map = twoLayerMap(10, 5);
    expect(clampTilemapCellRect(map, { minX: 8, minY: 6, maxX: 3, maxY: -2 })).toEqual({ minX: 3, minY: 0, maxX: 8, maxY: 4 });
    expect(clampTilemapCellRect(map, { minX: 10, minY: 0, maxX: 14, maxY: 2 })).toBeNull();
    const unbounded: TilemapPayload = { ...map, unbounded: true, pivot: { x: 0, y: 0 } };
    expect(clampTilemapCellRect(unbounded, { minX: -5, minY: TILEMAP_CELL_LIMIT - 1, maxX: -3, maxY: TILEMAP_CELL_LIMIT + 4 }))
      .toEqual({ minX: -5, minY: TILEMAP_CELL_LIMIT - 1, maxX: -3, maxY: TILEMAP_CELL_LIMIT });
  });

  it("selects the painted cells of one layer, or of every layer together", () => {
    let map = paint(twoLayerMap(), "a", ["1....", "...1."], 2, 3);
    map = paint(map, "b", ["2"], 9, 0);
    expect(tilemapSelectionExtent(map, "a")).toEqual({ minX: 2, minY: 2, maxX: 5, maxY: 3 });
    expect(tilemapSelectionExtent(map, null)).toEqual({ minX: 2, minY: 0, maxX: 9, maxY: 3 });
    expect(tilemapSelectionExtent(twoLayerMap(), null)).toBeNull();
  });
});

describe("copyTilemapCells", () => {
  it("copies one layer, or every layer, across chunk borders with the block's empty cells", () => {
    let map = paint(twoLayerMap(), "a", ["12.", ".34"], 3, 4);
    map = paint(map, "b", ["5.."], 3, 3);
    const one = copyTilemapCells(map, { minX: 3, minY: 3, maxX: 5, maxY: 4 }, "a");
    expect([one.width, one.height, one.allLayers, one.layers.map((layer) => layer.layerId)]).toEqual([3, 2, false, ["a"]]);
    expect(tilemapClipTileCount(one)).toBe(4);
    // Placed on an empty map at 0, 0, the clip draws the block as it was.
    expect(draw(placeTilemapClip(twoLayerMap(), one, { x: 0, y: 0 }), "a", { width: 4, top: 1 })).toEqual(["12..", ".34."]);
    const all = copyTilemapCells(map, { minX: 3, minY: 3, maxX: 5, maxY: 4 }, null);
    expect([all.allLayers, all.layers.map((layer) => layer.layerId), tilemapClipTileCount(all)]).toEqual([true, ["a", "b"], 5]);
  });

  it("takes whole chunks of a rect on the chunk grid as they are, without reading their cells", () => {
    const map = paint(twoLayerMap(), "a", ["1234", "5678", "1234", "5678"], 4, 3);
    const source = map.layers[0]!.chunks.find((chunk) => chunk.cx === 1 && chunk.cy === 0)!;
    const clip = copyTilemapCells(map, { minX: 4, minY: 0, maxX: 11, maxY: 5 }, "a");
    expect(clip.layers[0]!.chunks.map((chunk) => [chunk.cx, chunk.cy, chunk.tiles === source.tiles])).toEqual([[0, 0, true]]);
    expect(tilemapClipTileCount(clip)).toBe(16);
  });
});

describe("moveTilemapCells", () => {
  it("moves one layer's tiles over the destination, where empty cells of the block erase nothing", () => {
    let map = paint(twoLayerMap(), "a", ["1.2", "3.."], 0, 1);
    map = paint(map, "a", ["999", "999"], 4, 1);
    map = paint(map, "b", ["7.7", "7.."], 0, 1);
    const moved = moveTilemapCells(map, { minX: 0, minY: 0, maxX: 2, maxY: 1 }, "a", { x: 4, y: 0 });
    expect(draw(moved, "a", { width: 8, top: 1 })).toEqual(["....192.", "....399."]);
    // Other layers keep their tiles.
    expect(moved.layers[1]).toBe(map.layers[1]);
  });

  it("moves every layer's tiles together, each keeping its own, including onto overlapping cells", () => {
    let map = paint(twoLayerMap(), "a", ["12", "34"], 1, 2);
    map = paint(map, "b", ["5.", ".6"], 1, 2);
    const moved = moveTilemapCells(map, { minX: 1, minY: 1, maxX: 2, maxY: 2 }, null, { x: 1, y: -1 });
    expect(draw(moved, "a", { width: 5, top: 2 })).toEqual([".....", "..12.", "..34."]);
    expect(draw(moved, "b", { width: 5, top: 2 })).toEqual([".....", "..5..", "...6."]);
    expect(moveTilemapCells(map, { minX: 1, minY: 1, maxX: 2, maxY: 2 }, null, { x: 0, y: 0 })).toBe(map);
    expect(moveTilemapCells(map, { minX: 6, minY: 0, maxX: 8, maxY: 2 }, null, { x: 1, y: 0 })).toBe(map);
  });

  it("cuts off tiles moved past a bounded map's edge, and counts them before the move", () => {
    const map = paint(twoLayerMap(6, 3), "a", ["1234", "5678"], 2, 1);
    const rect = { minX: 2, minY: 0, maxX: 5, maxY: 1 };
    const clip = copyTilemapCells(map, rect, "a");
    // Three columns past x = 5 and the row below y = 0.
    expect(tilemapClipLostTiles(map, clip, { x: 5, y: 0 })).toBe(6);
    expect(tilemapClipLostTiles(map, clip, { x: 2, y: -1 })).toBe(4);
    expect(tilemapClipLostTiles(map, clip, { x: 20, y: 0 })).toBe(8);
    expect(tilemapClipLostTiles(map, clip, { x: 0, y: 1 })).toBe(0);
    const moved = moveTilemapCells(map, rect, "a", { x: 3, y: 0 });
    expect(draw(moved, "a", { width: 6, top: 1 })).toEqual([".....1", ".....5"]);
  });

  it("moves anywhere on an unbounded map, negative cells included, and clips only at the cell limit", () => {
    const map: TilemapPayload = { ...paint(twoLayerMap(), "a", ["12"], 0, 0), unbounded: true, pivot: { x: 0, y: 0 } };
    const moved = moveTilemapCells(map, { minX: 0, minY: 0, maxX: 1, maxY: 0 }, "a", { x: -40, y: -9 });
    expect([getTile(moved, "a", -40, -9), getTile(moved, "a", -39, -9), getTile(moved, "a", 0, 0)]).toEqual([1, 2, 0]);
    const clip = copyTilemapCells(map, { minX: 0, minY: 0, maxX: 1, maxY: 0 }, "a");
    expect(tilemapClipLostTiles(map, clip, { x: TILEMAP_CELL_LIMIT, y: 0 })).toBe(1);
    const edge = moveTilemapCells(map, { minX: 0, minY: 0, maxX: 1, maxY: 0 }, "a", { x: TILEMAP_CELL_LIMIT, y: 0 });
    expect(getTile(edge, "a", TILEMAP_CELL_LIMIT, 0)).toBe(1);
    expect(edge.layers[0]!.chunks.reduce((count, chunk) => count + chunk.tiles.filter(Boolean).length, 0)).toBe(1);
  });
});

describe("eraseTilemapCells", () => {
  it("empties the rect on one layer or every layer, and returns the map when it holds no tile", () => {
    let map = paint(twoLayerMap(), "a", ["123"], 0, 0);
    map = paint(map, "b", ["456"], 0, 0);
    const rect = { minX: 1, minY: 0, maxX: 2, maxY: 0 };
    expect(draw(eraseTilemapCells(map, rect, "a"), "a", { width: 3, top: 0 })).toEqual(["1.."]);
    expect(draw(eraseTilemapCells(map, rect, "a"), "b", { width: 3, top: 0 })).toEqual(["456"]);
    const both = eraseTilemapCells(map, rect, null);
    expect([...draw(both, "a", { width: 3, top: 0 }), ...draw(both, "b", { width: 3, top: 0 })]).toEqual(["1..", "4.."]);
    expect(eraseTilemapCells(map, { minX: 5, minY: 0, maxX: 8, maxY: 3 }, null)).toBe(map);
  });
});

describe("retargetTilemapClip", () => {
  it("re-numbers a clip for another map's Tilesets, leaves out tiles of Tilesets it lacks, and re-cuts its chunks", () => {
    const source: TilemapPayload = {
      ...paint(twoLayerMap(), "b", ["13", "6."], 0, 1),
      tilesets: [{ guid: "ground", firstGid: 1, tileCount: 4 }, { guid: "props", firstGid: 5, tileCount: 4 }],
    };
    const clip = copyTilemapCells(source, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, "b");
    const target: TilemapPayload = {
      ...createDefaultTilemapPayload(),
      chunkSize: 8,
      tilesets: [{ guid: "ground", firstGid: 21, tileCount: 4 }],
    };
    // A one-layer clip pastes into the paint layer; tile 6 is a props tile the target does not use.
    const ready = retargetTilemapClip(clip, target, "layer-1");
    expect([ready.chunkSize, ready.layers.map((layer) => layer.layerId)]).toEqual([8, ["layer-1"]]);
    const placed = placeTilemapClip(target, ready, { x: 2, y: 3 });
    expect([getTile(placed, "layer-1", 2, 4), getTile(placed, "layer-1", 3, 4), getTile(placed, "layer-1", 2, 3)]).toEqual([21, 23, 0]);
    // The same map takes it as it is.
    expect(retargetTilemapClip(clip, source, "b")).toBe(clip);
  });

  it("pastes a clip of every layer into the layers of the same id the map has", () => {
    let map = paint(twoLayerMap(), "a", ["1"], 0, 0);
    map = paint(map, "b", ["2"], 0, 0);
    const clip = copyTilemapCells(map, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, null);
    const target: TilemapPayload = { ...twoLayerMap(), layers: [createTilemapLayer("b", "B")] };
    const ready = retargetTilemapClip(clip, target, "b");
    expect(ready.layers.map((layer) => layer.layerId)).toEqual(["b"]);
    expect(getTile(placeTilemapClip(target, ready, { x: 4, y: 4 }), "b", 4, 4)).toBe(2);
  });
});

describe("selection edits on autotiles", () => {
  // Ledge (4 Sides) pieces by local id: 1 single, 2 left end, 3 middle, 4 right end.
  const LEDGE = ensureTilesetTiles(normalizeTilesetPayload({
    atlasWidth: 64,
    atlasHeight: 16,
    terrains: [{ id: "ledge", name: "Ledge", style: "sides" }],
    tiles: [0, TERRAIN_E, TERRAIN_E | TERRAIN_W, TERRAIN_W].map((mask, at) => ({ id: at + 1, terrain: { id: "ledge", mask } })),
  }));
  const TILESETS = new Map([["ts", LEDGE]]);
  const legend = (rows: string[]) => rows.map((row) => row.replace(/[1-4]/g, (gid) => ".dlmr"[Number(gid)]!));
  /**
   * Hand-placed on a map current with the Tileset (so no stale refresh re-picks them): a 3 × 3 block of
   * middles with a single in its centre, a right end joined to it and a lone single.
   */
  const start = () => {
    const map: TilemapPayload = {
      ...twoLayerMap(16, 6),
      tilesets: [{ guid: "ts", firstGid: 1, tileCount: 4, terrainStamp: tilesetTerrainStamp(LEDGE) }],
    };
    return paint(map, "a", [".333.......", ".3134.1....", ".333......."], 0, 3);
  };
  const view = (map: TilemapPayload) => legend(draw(map, "a", { width: 11, bottom: 1, top: 3 }));

  it("re-picks the pieces around the vacated cells and the destination, and keeps a moved tile its neighbours moved with", () => {
    const map = start();
    expect(view(map)).toEqual([".mmm.......", ".mdmr.d....", ".mmm......."]);
    const moved = moveTilemapCells(map, { minX: 1, minY: 1, maxX: 3, maxY: 3 }, "a", { x: 6, y: 0 }, TILESETS);
    expect(view(moved)).toEqual([
      ".......lmr.",
      // The right end left behind is single now; the lone single joins the block's left side.
      "....d.lmdr.",
      ".......lmr.",
    ]);
    // Without the Tilesets the tiles move as they are.
    expect(view(moveTilemapCells(map, { minX: 1, minY: 1, maxX: 3, maxY: 3 }, "a", { x: 6, y: 0 }))).toEqual([
      ".......mmm.", "....r.dmdm.", ".......mmm.",
    ]);
  });

  it("re-picks the pieces around deleted cells and around a pasted block", () => {
    const map = start();
    const block = { minX: 1, minY: 1, maxX: 3, maxY: 3 };
    expect(view(eraseTilemapCells(map, block, "a", TILESETS))[1]).toBe("....d.d....");
    const pasted = placeTilemapClip(map, copyTilemapCells(map, block, "a"), { x: 7, y: 1 }, TILESETS);
    expect(view(pasted)).toEqual([".mmm...lmr.", ".mdmr.lmdr.", ".mmm...lmr."]);
  });
});
