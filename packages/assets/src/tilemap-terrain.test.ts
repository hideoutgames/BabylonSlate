import { describe, expect, it } from "vitest";
import {
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
} from "./tileset-terrain";
import { normalizeTilesetPayload, type TilesetPayload } from "./tileset-payload";
import {
  createDefaultTilemapPayload,
  getTile,
  setTile,
  TilemapChunkIndex,
  type TilemapPayload,
} from "./tilemap-payload";
import { applyTilemapPaint, type TileCell, type TilemapPaintStroke } from "./tilemap-paint";
import { paintTilemapTerrain, type TilemapTerrainBrush } from "./tilemap-terrain";

const E = TERRAIN_E;
const SE = TERRAIN_SE;
const S = TERRAIN_S;
const SW = TERRAIN_SW;
const W = TERRAIN_W;

/**
 * Tile legend by local id. Grass (blob) 1-9: `o` block, `[` `]` island ends,
 * `L` `T` `R` top row, `#` fill, `q` `p` fill notched at NE / NW. Ledge
 * (4-side) 10-13: `d` single, `l` `m` `r` left, middle, right. `x` 14 is a
 * plain tile.
 */
const LEGEND = ".o[]LTR#qpdlmrx";
const TILESET: TilesetPayload = normalizeTilesetPayload({
  terrains: [
    { id: "grass", name: "Grass", style: "blob" },
    { id: "ledge", name: "Ledge", style: "sides" },
  ],
  tiles: [
    ...[0, E, W, E | SE | S, E | SE | S | SW | W, S | SW | W, TERRAIN_ALL, TERRAIN_ALL & ~TERRAIN_NE, TERRAIN_ALL & ~TERRAIN_NW]
      .map((mask, at) => ({ id: at + 1, terrain: { id: "grass", mask } })),
    ...[0, E, E | W, W].map((mask, at) => ({ id: at + 10, terrain: { id: "ledge", mask } })),
    { id: 14 },
  ],
});
const TILESETS = new Map([["ts", TILESET]]);
const GRASS: TilemapTerrainBrush = { guid: "ts", terrainId: "grass" };
const LEDGE: TilemapTerrainBrush = { guid: "ts", terrainId: "ledge" };
/** Map GIDs start at 101 so a missing GID offset cannot pass. */
const FIRST_GID = 101;

function emptyMap(chunkSize = 32): TilemapPayload {
  return {
    ...createDefaultTilemapPayload(),
    tilesets: [{ guid: "ts", firstGid: FIRST_GID, tileCount: 14 }],
    width: 8,
    height: 6,
    chunkSize,
  };
}

/** Rows top to bottom, one legend character per cell. */
function draw(map: TilemapPayload): string[] {
  const rows: string[] = [];
  for (let y = map.height - 1; y >= 0; y--) {
    let row = "";
    for (let x = 0; x < map.width; x++) {
      const gid = getTile(map, "layer-1", x, y);
      row += gid === 0 ? "." : (LEGEND[gid - FIRST_GID + 1] ?? "?");
    }
    rows.push(row);
  }
  return rows;
}

/** `X` cells of six `rows` drawn top to bottom, in +Y-up tile space. */
function cellsOf(rows: readonly string[]): TileCell[] {
  const cells: TileCell[] = [];
  rows.forEach((row, at) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "X") cells.push({ x, y: 5 - at });
  });
  return cells;
}

function paint(map: TilemapPayload, cells: Iterable<TileCell>, terrain: TilemapTerrainBrush | null = GRASS) {
  return paintTilemapTerrain(map, { layerId: "layer-1", cells, terrain, tilesets: TILESETS });
}

const ISLAND = cellsOf([
  "........",
  "...XX...",
  "..XXX...",
  "..XXX...",
  "........",
  "XX......",
]);

describe("paintTilemapTerrain", () => {
  it("resolves a stepped blob island with its inner corner, and ground on the map edge", () => {
    expect(draw(paint(emptyMap(), ISLAND))).toEqual([
      "........",
      "...LR...",
      "..Lp#...",
      "..###...",
      "........",
      // Outside the map joins, so ground on the bottom edge runs on below it.
      "TR......",
    ]);
  });

  it("matches only the 4 sides for a 4-side terrain", () => {
    const cells = cellsOf(["........", "........", "........", "..X.....", ".XXXX...", "..X....."]);
    // Diagonal neighbours never count; a crossing falls back to the closest straight piece.
    expect(draw(paint(emptyMap(), cells, LEDGE)).slice(3)).toEqual(["..d.....", ".lmmr...", "..d....."]);
  });

  it("resolves the same across chunk borders and empty chunks as in one chunk", () => {
    expect(draw(paint(emptyMap(2), ISLAND))).toEqual(draw(paint(emptyMap(32), ISLAND)));
    const strip = paint(emptyMap(2), [{ x: 2, y: 2 }, { x: 3, y: 2 }]);
    expect(strip.layers[0]!.chunks.map((chunk) => [chunk.cx, chunk.cy])).toEqual([[1, 1]]);
    // Painting below, in a chunk that does not exist yet, turns the strip into a block top.
    const block = paint(strip, [{ x: 2, y: 1 }, { x: 3, y: 1 }]);
    expect(draw(strip).slice(3, 5)).toEqual(["..[]....", "........"]);
    expect(draw(block).slice(3, 5)).toEqual(["..LR....", "..##...."]);
  });

  it("matches a whole stroke when its cells arrive one move at a time", () => {
    const index = new TilemapChunkIndex(true);
    let stroked = emptyMap(2);
    for (const cell of ISLAND) {
      stroked = paintTilemapTerrain(stroked, { layerId: "layer-1", cells: [cell], terrain: GRASS, tilesets: TILESETS, index });
    }
    expect(draw(stroked)).toEqual(draw(paint(emptyMap(2), ISLAND)));
  });

  it("returns the same map when a terrain stroke changes nothing", () => {
    const painted = paint(emptyMap(), ISLAND);
    expect(paint(painted, ISLAND)).toBe(painted);
    expect(paint(painted, [{ x: -1, y: 0 }, { x: 8, y: 3 }])).toBe(painted);
    expect(paint(painted, [{ x: 6, y: 3 }], { guid: "ts", terrainId: "missing" })).toBe(painted);
  });

  it("erases cells, re-resolves the terrain around them and drops emptied chunks", () => {
    const painted = paint(emptyMap(2), ISLAND);
    const erased = paint(painted, [{ x: 4, y: 3 }, { x: 4, y: 4 }], null);
    expect(draw(erased).slice(1, 4)).toEqual(["...L....", "..Lp....", "..#q]..."]);
    const cleared = paint(erased, ISLAND, null);
    expect(cleared.layers[0]!.chunks).toEqual([]);
  });

  it("re-resolves another terrain next to painted cells but never a plain tile", () => {
    let map = setTile(emptyMap(), "layer-1", 3, 2, FIRST_GID + 13);
    map = paint(map, [{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }], LEDGE);
    expect(draw(map)[3]).toBe("mmrx....");
    map = paint(map, [{ x: 2, y: 2 }]);
    expect(draw(map)[3]).toBe("mrox....");
  });
});

describe("applyTilemapPaint with a terrain", () => {
  const stroke = (tool: TilemapPaintStroke["tool"], start: TileCell, end = start): TilemapPaintStroke => ({
    tool,
    layerId: "layer-1",
    tileId: 0,
    start,
    end,
    terrain: GRASS,
  });

  it("fills a rectangle and a stamp with terrain, and needs the Tilesets", () => {
    const map = emptyMap();
    expect(applyTilemapPaint(map, stroke("rect", { x: 1, y: 1 }, { x: 3, y: 2 }))).toBe(map);
    const rect = applyTilemapPaint(map, stroke("rect", { x: 1, y: 1 }, { x: 3, y: 2 }), undefined, TILESETS);
    expect(draw(rect).slice(3, 5)).toEqual([".LTR....", ".###...."]);
    const stamp = applyTilemapPaint(
      map,
      { ...stroke("stamp", { x: 1, y: 1 }), stamp: { width: 2, height: 2, tiles: [] } },
      undefined,
      TILESETS,
    );
    expect(draw(stamp).slice(3, 5)).toEqual([".LR.....", ".##....."]);
  });

  it("buckets a terrain region whatever its variants, and nothing that is already that terrain", () => {
    const ledges = paint(emptyMap(), [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 5, y: 2 }], LEDGE);
    expect(draw(ledges)[3]).toBe(".lmr.d..");
    const filled = applyTilemapPaint(ledges, stroke("bucket", { x: 2, y: 2 }), undefined, TILESETS);
    expect(draw(filled)[3]).toBe(".[T].d..");
    expect(applyTilemapPaint(filled, stroke("bucket", { x: 1, y: 2 }), undefined, TILESETS)).toBe(filled);
  });

  it("erases with the Eraser and re-resolves the neighbours", () => {
    const strip = applyTilemapPaint(emptyMap(), stroke("rect", { x: 1, y: 1 }, { x: 3, y: 1 }), undefined, TILESETS);
    expect(draw(strip)[4]).toBe(".[T]....");
    const erased = applyTilemapPaint(strip, { ...stroke("eraser", { x: 3, y: 1 }), cells: [{ x: 3, y: 1 }] }, undefined, TILESETS);
    expect(draw(erased)[4]).toBe(".[].....");
  });
});
