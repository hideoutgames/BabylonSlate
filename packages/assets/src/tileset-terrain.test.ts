import { describe, expect, it } from "vitest";
import {
  applyAutotileLayout,
  AUTOTILE_LAYOUTS,
  autotileLayoutPlacement,
  autotileZoneOn,
  canonicalTerrainMask,
  createTerrainResolver,
  missingTerrainVariants,
  setAutotileZone,
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
  terrainVariantMasks,
} from "./tileset-terrain";
import { ensureTilesetTiles, normalizeTilesetPayload, type TilesetPayload, type TilesetTerrainStyle } from "./tileset-payload";

const N = TERRAIN_N;
const NE = TERRAIN_NE;
const E = TERRAIN_E;
const SE = TERRAIN_SE;
const S = TERRAIN_S;
const SW = TERRAIN_SW;
const W = TERRAIN_W;
const NW = TERRAIN_NW;

/** One terrain whose tile `n` (1-based) joins `masks[n - 1]`. */
function terrainSheet(style: TilesetTerrainStyle, masks: readonly number[]): TilesetPayload {
  return normalizeTilesetPayload({
    terrains: [{ id: "ground", name: "Ground", style }],
    tiles: masks.map((mask, at) => ({ id: at + 1, terrain: { id: "ground", mask } })),
  });
}

/**
 * The grass set of a typical platformer sheet: a single block, both island
 * ends, a top row, square dirt fill and two inner-corner fills. No bottom or
 * side edges and no outer corners below the top.
 */
const GRASS = {
  block: 1,
  islandLeft: 2,
  islandRight: 3,
  topLeft: 4,
  top: 5,
  topRight: 6,
  fill: 7,
  notchNE: 8,
  notchNW: 9,
} as const;
const GRASS_MASKS = [
  0,
  E,
  W,
  E | SE | S,
  E | SE | S | SW | W,
  S | SW | W,
  TERRAIN_ALL,
  TERRAIN_ALL & ~NE,
  TERRAIN_ALL & ~NW,
];

describe("terrain masks", () => {
  it("has 16 variants for 4-side match and 47 for the 8-neighbour blob", () => {
    expect(terrainVariantMasks("sides")).toHaveLength(16);
    expect(terrainVariantMasks("blob")).toHaveLength(47);
  });

  it("counts a blob corner only when both of its sides join", () => {
    expect(canonicalTerrainMask("blob", N | NE)).toBe(N);
    expect(canonicalTerrainMask("blob", N | E | NE | SW)).toBe(N | E | NE);
    expect(canonicalTerrainMask("sides", TERRAIN_ALL)).toBe(N | E | S | W);
  });
});

describe("terrain resolution", () => {
  for (const style of ["sides", "blob"] as const) {
    it(`picks the exact tile for every neighbourhood of a complete ${style} sheet`, () => {
      const variants = terrainVariantMasks(style);
      const resolve = createTerrainResolver(terrainSheet(style, variants), "ground")!;
      for (let mask = 0; mask <= TERRAIN_ALL; mask++) {
        expect(variants[resolve(mask) - 1], `mask ${mask}`).toBe(canonicalTerrainMask(style, mask));
      }
    });
  }

  it("picks the closest tile of an incomplete blob sheet in the documented order", () => {
    const resolve = createTerrainResolver(terrainSheet("blob", GRASS_MASKS), "ground")!;
    const table: Array<[string, number, number]> = [
      ["exact: top row", E | SE | S | SW | W, GRASS.top],
      ["exact: inner corner", TERRAIN_ALL & ~NW, GRASS.notchNW],
      // 1. No edge inside the terrain: the bottom-left of a block is fill, not an island end.
      ["fewest missing sides", N | E | NE, GRASS.fill],
      // 2. A one-tile-high strip keeps its grass top rather than fill.
      ["then fewest extra sides", E | W, GRASS.top],
      // 3. The right edge under a cap is fill, not a tile notched at its open corner.
      ["then fewest unwanted notches", N | S | W | NW | SW, GRASS.fill],
      // 4. A crossing wants four notches; a notched tile is closer than plain fill.
      ["then fewest missing notches", N | E | S | W, GRASS.notchNE],
      // 5. Both ends of a column top cost one extra side: the lower id wins.
      ["then the lowest tile id", S, GRASS.topLeft],
    ];
    expect(table.map(([label, mask]) => [label, resolve(mask)])).toEqual(
      table.map(([label, , tile]) => [label, tile]),
    );
  });

  it("ignores corners for a 4-side terrain", () => {
    const ledge = terrainSheet("sides", [0, E, E | W, W]);
    const resolve = createTerrainResolver(ledge, "ground")!;
    expect(resolve(E | W | NE | SE | SW | NW)).toBe(3);
    // Stacked ledges have no vertical variants: the open single piece is closest.
    expect(resolve(N | S)).toBe(1);
  });

  it("resolves nothing for a terrain without tiles in range", () => {
    const sheet = terrainSheet("blob", GRASS_MASKS);
    expect(createTerrainResolver(sheet, "missing")).toBeNull();
    expect(createTerrainResolver(normalizeTilesetPayload({ ...sheet, tiles: [] }), "ground")).toBeNull();
    expect(createTerrainResolver(sheet, "ground", GRASS.top)?.(TERRAIN_ALL)).toBe(GRASS.top);
  });
});

/** A 12 × 6 atlas of 16 px tiles with one terrain of `style`, no member tiles yet. */
function blankSheet(style: TilesetTerrainStyle): TilesetPayload {
  return ensureTilesetTiles(normalizeTilesetPayload({
    tileWidth: 16, tileHeight: 16, atlasWidth: 16 * 12, atlasHeight: 16 * 6,
    terrains: [{ id: "ground", name: "Ground", style }],
  }));
}

describe("standard autotile layouts", () => {
  it("lays out every variant of a style exactly once", () => {
    for (const style of ["sides", "blob"] as const) {
      const layout = AUTOTILE_LAYOUTS[style];
      const masks = layout.masks.filter((mask): mask is number => mask !== null);
      expect(layout.masks).toHaveLength(layout.columns * layout.rows);
      expect([...masks].sort((a, b) => a - b)).toEqual(terrainVariantMasks(style));
    }
    // The 4 Sides block reads as an island: top-left joins east and south, the centre all four sides.
    expect(AUTOTILE_LAYOUTS.sides.masks.slice(0, 2)).toEqual([E | S, E | S | W]);
    expect(AUTOTILE_LAYOUTS.sides.masks[5]).toBe(N | E | S | W);
    // Blob's first four columns are that island with solid inner corners.
    expect(AUTOTILE_LAYOUTS.blob.masks[0]).toBe(E | SE | S);
    expect(AUTOTILE_LAYOUTS.blob.masks[13]).toBe(TERRAIN_ALL);
  });

  it("places a layout from its top-left tile and refuses one that runs past the atlas", () => {
    const sheet = blankSheet("sides");
    // 12 columns: tile 14 is column 2, row 2.
    const placement = autotileLayoutPlacement(sheet, "sides", 14)!;
    expect(placement.slice(0, 5).map((cell) => cell.tileId)).toEqual([14, 15, 16, 17, 26]);
    expect(placement.at(-1)).toEqual({ tileId: 53, mask: 0 });
    expect(autotileLayoutPlacement(sheet, "sides", 10)).toBeNull();
    expect(autotileLayoutPlacement(sheet, "sides", 12 * 3 + 1)).toBeNull();
    expect(autotileLayoutPlacement(sheet, "blob", 1)?.length).toBe(48);
    expect(autotileLayoutPlacement(sheet, "blob", 2)).toBeNull();
  });

  it("fills a block's tiles with the terrain and its neighbours, leaving other tiles and unused cells alone", () => {
    const sheet = blankSheet("blob");
    const withOther = { ...sheet, tiles: sheet.tiles.map((tile) => (tile.id === 48 ? { ...tile, terrain: { id: "other", mask: 5 } } : tile)) };
    const filled = applyAutotileLayout(withOther, "ground", 1);
    expect(missingTerrainVariants(filled, "ground")).toEqual([]);
    expect(filled.tiles.find((tile) => tile.id === 1)?.terrain).toEqual({ id: "ground", mask: E | SE | S });
    // The block's one unused cell keeps what it had.
    expect(filled.tiles.find((tile) => tile.id === 48)?.terrain).toEqual({ id: "other", mask: 5 });
    expect(filled.tiles.find((tile) => tile.id === 49)?.terrain).toBeUndefined();
    expect(applyAutotileLayout(sheet, "ground", 2)).toBe(sheet);
    expect(applyAutotileLayout(sheet, "missing", 1)).toBe(sheet);
  });
});

describe("autotile zones", () => {
  const tile = { id: 1, collision: "none" as const, flags: 0, animation: [] };

  it("joins a tile with any zone, brings a corner's sides along and takes a side's corners away", () => {
    const corner = setAutotileZone(tile, "ground", NE, true);
    expect(corner.terrain).toEqual({ id: "ground", mask: N | NE | E });
    expect(autotileZoneOn(corner, "ground", 0)).toBe(true);
    expect(autotileZoneOn(corner, "ground", S)).toBe(false);
    expect(setAutotileZone(corner, "ground", N, false).terrain).toEqual({ id: "ground", mask: E });
    expect(setAutotileZone(tile, "ground", 0, true).terrain).toEqual({ id: "ground", mask: 0 });
    expect(setAutotileZone(corner, "ground", 0, false).terrain).toBeUndefined();
  });

  it("moves a tile of another terrain over with no neighbours, and leaves it when only turning zones off", () => {
    const other = { ...tile, terrain: { id: "water", mask: N | E } };
    expect(setAutotileZone(other, "ground", S, true).terrain).toEqual({ id: "ground", mask: S });
    expect(setAutotileZone(other, "ground", N, false)).toBe(other);
    expect(setAutotileZone(other, "ground", 0, false)).toBe(other);
    expect(autotileZoneOn(other, "ground", N)).toBe(false);
  });
});

