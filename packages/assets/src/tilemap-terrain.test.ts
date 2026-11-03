import { describe, expect, it } from "vitest";
import {
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_N,
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
import { paintTilemapTerrain, refreshTilemapTerrains, type TilemapTerrainBrush } from "./tilemap-terrain";

const N = TERRAIN_N;
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
  atlasWidth: 16 * 14,
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

  it("re-resolves the neighbours with the Eraser even without a terrain brush, but never a plain tile", () => {
    const strip = applyTilemapPaint(emptyMap(), stroke("rect", { x: 1, y: 1 }, { x: 3, y: 1 }), undefined, TILESETS);
    const withPlain = setTile(strip, "layer-1", 5, 1, FIRST_GID + 13);
    const eraser: TilemapPaintStroke = { tool: "eraser", layerId: "layer-1", tileId: 0, start: { x: 3, y: 1 }, end: { x: 3, y: 1 }, cells: [{ x: 3, y: 1 }, { x: 4, y: 1 }] };
    expect(draw(applyTilemapPaint(withPlain, eraser, undefined, TILESETS))[4]).toBe(".[]..x..");
    // Without the Tilesets the Eraser only clears.
    expect(draw(applyTilemapPaint(withPlain, eraser))[4]).toBe(".[T..x..");
  });
});

/** The 4-side pieces of a one-row map, whose north and south run on past the map edge. */
const SHAPES = [["=", N | E | S | W], ["]", N | S | W], ["[", N | E | S], ["|", N | S]] as const;
/**
 * Each set of the transition Tileset, with the four `SHAPES` in order. Grass
 * has sets drawn against Dirt and Rock, and declares Sand without tiles; Dirt
 * and Sand have sets drawn against Grass; Rock has none.
 */
const SETS = [["grass"], ["grass", "dirt"], ["grass", "rock"], ["dirt"], ["dirt", "grass"], ["sand"], ["sand", "grass"], ["rock"]] as const;
const MOSS_FIRST = SETS.length * SHAPES.length + 1;
/** Labels by local id: `grass>dirt]` is Grass drawn against Dirt, open east. Moss (blob) is a fill and a fill notched NE. */
const TRANSITION_LABELS = [
  "",
  ...SETS.flatMap(([terrain, border]) => SHAPES.map(([shape]) => `${terrain}${border ? `>${border}` : ""}${shape}`)),
  "moss#",
  "moss>dirt#",
  "moss>dirt q",
];
const TRANSITIONS: TilesetPayload = normalizeTilesetPayload({
  atlasWidth: 16 * (TRANSITION_LABELS.length - 1),
  terrains: [
    { id: "grass", name: "Grass", style: "sides", borders: ["dirt", "rock", "sand"] },
    { id: "dirt", name: "Dirt", style: "sides", borders: ["grass"] },
    { id: "sand", name: "Sand", style: "sides", borders: ["grass"] },
    { id: "rock", name: "Rock", style: "sides" },
    { id: "moss", name: "Moss", style: "blob", borders: ["dirt"] },
  ],
  tiles: [
    ...SETS.flatMap(([terrain, border], set) => SHAPES.map(([, mask], shape) => ({
      id: set * SHAPES.length + shape + 1,
      terrain: border ? { id: terrain, mask, border } : { id: terrain, mask },
    }))),
    { id: MOSS_FIRST, terrain: { id: "moss", mask: TERRAIN_ALL } },
    { id: MOSS_FIRST + 1, terrain: { id: "moss", mask: TERRAIN_ALL, border: "dirt" } },
    { id: MOSS_FIRST + 2, terrain: { id: "moss", mask: TERRAIN_ALL & ~TERRAIN_NE, border: "dirt" } },
  ],
});
/** The same Tileset under a second guid, so its terrains are other terrains. */
const TRANSITION_TILESETS = new Map([["tr", TRANSITIONS], ["tr2", TRANSITIONS]]);
const TRANSITION_COUNT = TRANSITION_LABELS.length - 1;

function transitionMap(width: number, height: number, chunkSize = 32): TilemapPayload {
  return {
    ...createDefaultTilemapPayload(),
    tilesets: [
      { guid: "tr", firstGid: FIRST_GID, tileCount: TRANSITION_COUNT },
      { guid: "tr2", firstGid: FIRST_GID + 100, tileCount: TRANSITION_COUNT },
    ],
    width,
    height,
    chunkSize,
  };
}

/** Paint terrain cells given as rows top to bottom: `g` Grass, `d` Dirt, `s` Sand, `r` Rock, `m` Moss, `D` Dirt of the second Tileset. */
function paintRows(map: TilemapPayload, rows: readonly string[], index?: TilemapChunkIndex): TilemapPayload {
  const terrains: Record<string, TilemapTerrainBrush> = {
    g: { guid: "tr", terrainId: "grass" },
    d: { guid: "tr", terrainId: "dirt" },
    s: { guid: "tr", terrainId: "sand" },
    r: { guid: "tr", terrainId: "rock" },
    m: { guid: "tr", terrainId: "moss" },
    D: { guid: "tr2", terrainId: "dirt" },
  };
  let next = map;
  rows.forEach((row, at) => {
    for (let x = 0; x < row.length; x++) {
      const terrain = terrains[row[x]!];
      const cells = [{ x, y: rows.length - 1 - at }];
      if (terrain) next = paintTilemapTerrain(next, { layerId: "layer-1", cells, terrain, tilesets: TRANSITION_TILESETS, index });
    }
  });
  return next;
}

/** The label of a cell of the first transition Tileset (second Tileset cells read `tr2:` and their label). */
function transitionAt(map: TilemapPayload, x: number, y: number): string {
  const gid = getTile(map, "layer-1", x, y);
  if (gid === 0) return ".";
  if (gid >= FIRST_GID + 100) return `tr2:${TRANSITION_LABELS[gid - FIRST_GID - 100 + 1]}`;
  return TRANSITION_LABELS[gid - FIRST_GID + 1] ?? "?";
}

function transitionRow(map: TilemapPayload, y = 0): string[] {
  return Array.from({ length: map.width }, (_, x) => transitionAt(map, x, y));
}

describe("terrain transitions", () => {
  it("draws both sides of a seam when each terrain has a set for the other", () => {
    expect(transitionRow(paintRows(transitionMap(4, 1), ["ggdd"]))).toEqual(["grass=", "grass>dirt]", "dirt>grass[", "dirt="]);
  });

  it("joins a terrain into a neighbour whose set draws the seam", () => {
    // Grass declares Sand but has no tiles for it, so Sand's set draws the seam.
    expect(transitionRow(paintRows(transitionMap(2, 1), ["gs"]))).toEqual(["grass=", "sand>grass["]);
    // Rock has no set: Grass draws the seam against it and Rock runs on under it.
    expect(transitionRow(paintRows(transitionMap(2, 1), ["gr"]))).toEqual(["grass>rock]", "rock="]);
  });

  it("faces nothing across terrains without sets and across Tilesets", () => {
    expect(transitionRow(paintRows(transitionMap(2, 1), ["ds"]))).toEqual(["dirt]", "sand["]);
    expect(transitionRow(paintRows(transitionMap(2, 1), ["gD"]))).toEqual(["grass]", "tr2:dirt["]);
  });

  it("picks the border faced most often, and the default set on a tie", () => {
    expect(transitionRow(paintRows(transitionMap(3, 1), ["dgr"]))[1]).toBe("grass|");
    // Dirt north and east, Rock west, nothing south: the Dirt set's closest piece.
    expect(transitionAt(paintRows(transitionMap(3, 3), [".d.", "rgd", "..."]), 1, 1)).toBe("grass>dirt|");
  });

  it("takes a Blob terrain's set from its open corners when every side joins, but never a 4 Sides terrain's", () => {
    expect(transitionAt(paintRows(transitionMap(3, 3), ["mmd", "mmm", "mmm"]), 1, 1)).toBe("moss>dirt q");
    expect(transitionAt(paintRows(transitionMap(3, 3), ["ggd", "ggg", "ggg"]), 1, 1)).toBe("grass=");
    // Moss joined on every side and corner draws its default fill.
    expect(transitionAt(paintRows(transitionMap(3, 3), ["mmm", "mmm", "mmm"]), 1, 1)).toBe("moss#");
  });

  it("re-resolves exactly once per stroke, one cell at a time or all at once", () => {
    const rows = ["ggddgg", "gsgdrg", "mmdgsd", "mmmdgg"];
    const oneByOne = paintRows(transitionMap(6, 4, 2), rows, new TilemapChunkIndex(true));
    // Each terrain painted as one batch of cells, the second batch re-resolving the first's neighbours.
    const cellsOf = (letter: string) => rows.flatMap((row, at) =>
      [...row].flatMap((char, x) => (char === letter ? [{ x, y: rows.length - 1 - at }] : [])));
    let batched = transitionMap(6, 4, 2);
    for (const [letter, terrainId] of [["g", "grass"], ["d", "dirt"], ["s", "sand"], ["r", "rock"], ["m", "moss"]] as const) {
      batched = paintTilemapTerrain(batched, { layerId: "layer-1", cells: cellsOf(letter), terrain: { guid: "tr", terrainId }, tilesets: TRANSITION_TILESETS });
    }
    const draw = (map: TilemapPayload) => [3, 2, 1, 0].map((y) => transitionRow(map, y));
    expect(draw(oneByOne)).toEqual(draw(batched));
    // Re-resolving every cell from scratch changes nothing: no neighbour was left stale.
    expect(draw(refreshTilemapTerrains(oneByOne, TRANSITION_TILESETS))).toEqual(draw(oneByOne));
    expect(refreshTilemapTerrains(oneByOne, TRANSITION_TILESETS)).toBe(oneByOne);
  });
});

describe("refreshTilemapTerrains", () => {
  it("re-picks every terrain tile on every layer from its neighbours and leaves plain tiles and unknown terrains", () => {
    let map = paint(emptyMap(), ISLAND);
    map = setTile(map, "layer-1", 7, 0, FIRST_GID + 13);
    map = { ...map, layers: [...map.layers, { ...map.layers[0]!, id: "layer-2", name: "Layer 2" }] };
    // Before the fill tile existed the island's centre painted the closest tile; adding it to the Tileset changes nothing until a refresh.
    const withoutFill = new Map([["ts", { ...TILESET, tiles: TILESET.tiles.map((tile) => (tile.id === 7 ? { id: 7, collision: "none" as const, flags: 0, animation: [] } : tile)) }]]);
    const stale = refreshTilemapTerrains(map, withoutFill);
    expect(draw(stale)).not.toEqual(draw(map));
    const refreshed = refreshTilemapTerrains(stale, TILESETS);
    expect(draw(refreshed)).toEqual(draw(map));
    expect(getTile(refreshed, "layer-2", 4, 2)).toBe(getTile(map, "layer-1", 4, 2));
    expect(getTile(refreshed, "layer-1", 7, 0)).toBe(FIRST_GID + 13);
    expect(refreshTilemapTerrains(refreshed, TILESETS)).toBe(refreshed);
  });
});
