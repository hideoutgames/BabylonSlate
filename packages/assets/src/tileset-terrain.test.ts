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

/** One terrain whose tile `n` (1-based) joins `masks[n - 1]`, on a one-row atlas of exactly those tiles. */
function terrainSheet(style: TilesetTerrainStyle, masks: readonly number[]): TilesetPayload {
  return normalizeTilesetPayload({
    atlasWidth: 16 * masks.length,
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
      const { resolve } = createTerrainResolver(terrainSheet(style, variants), "ground")!;
      for (let mask = 0; mask <= TERRAIN_ALL; mask++) {
        expect(variants[resolve(mask) - 1], `mask ${mask}`).toBe(canonicalTerrainMask(style, mask));
      }
    });
  }

  it("picks the closest tile of an incomplete blob sheet in the documented order", () => {
    const { resolve } = createTerrainResolver(terrainSheet("blob", GRASS_MASKS), "ground")!;
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
    const { resolve } = createTerrainResolver(ledge, "ground")!;
    expect(resolve(E | W | NE | SE | SW | NW)).toBe(3);
    // Stacked ledges have no vertical variants: the open single piece is closest.
    expect(resolve(N | S)).toBe(1);
  });

  it("resolves nothing for a terrain without tiles in range, and never a tile past the atlas", () => {
    const sheet = terrainSheet("blob", GRASS_MASKS);
    expect(createTerrainResolver(sheet, "missing")).toBeNull();
    expect(createTerrainResolver(normalizeTilesetPayload({ ...sheet, tiles: [] }), "ground")).toBeNull();
    expect(createTerrainResolver(sheet, "ground", GRASS.top)?.resolve(TERRAIN_ALL)).toBe(GRASS.top);
    // The fill tile lies past a shrunk atlas: the closest tile inside it wins, as with `ensureTilesetTiles`.
    const shrunk = { ...sheet, atlasWidth: 16 * GRASS.topRight };
    expect(createTerrainResolver(shrunk, "ground")!.resolve(TERRAIN_ALL)).toBe(GRASS.top);
    expect(createTerrainResolver(ensureTilesetTiles(shrunk), "ground")!.resolve(TERRAIN_ALL)).toBe(GRASS.top);
  });
});

/**
 * A 4 Sides Grass with a default set (1 single, 2 fill) and a set drawn
 * against Dirt (3 open north, 4 fill); its set against Water has no tiles.
 * Dirt has only a set drawn against Grass (5 single). Tile 6, past the
 * 5-tile atlas, would be Grass's exact open-north piece.
 */
const BORDERED = normalizeTilesetPayload({
  atlasWidth: 16 * 5,
  terrains: [
    { id: "grass", name: "Grass", style: "sides", borders: ["dirt", "water"] },
    { id: "dirt", name: "Dirt", style: "sides", borders: ["grass"] },
    { id: "water", name: "Water", style: "sides" },
  ],
  tiles: [
    { id: 1, terrain: { id: "grass", mask: 0 } },
    { id: 2, terrain: { id: "grass", mask: N | E | S | W } },
    { id: 3, terrain: { id: "grass", mask: E | S | W, border: "dirt" } },
    { id: 4, terrain: { id: "grass", mask: N | E | S | W, border: "dirt" } },
    { id: 5, terrain: { id: "dirt", mask: 0, border: "grass" } },
    { id: 6, terrain: { id: "grass", mask: E | S | W } },
  ],
});

describe("terrain border sets", () => {
  it("lists only the border sets that have tiles", () => {
    expect([...createTerrainResolver(BORDERED, "grass")!.borders]).toEqual(["dirt"]);
    expect([...createTerrainResolver(BORDERED, "dirt")!.borders]).toEqual(["grass"]);
    expect(createTerrainResolver(BORDERED, "water")).toBeNull();
  });

  it("picks only from the chosen set, then the default set, then every tile", () => {
    const grass = createTerrainResolver(BORDERED, "grass")!;
    expect(grass.resolve(E | S | W, "dirt")).toBe(3);
    // The default set has no open-north piece: its fill draws no edge inside the terrain.
    expect(grass.resolve(E | S | W)).toBe(2);
    // A set wins even when the default set holds the exact tile.
    expect(grass.resolve(0, "dirt")).toBe(3);
    expect(grass.resolve(0)).toBe(1);
    // The Water set has no tiles: the default set answers.
    expect(grass.resolve(E | S | W, "water")).toBe(2);
    // Dirt has no default set: every Dirt tile is a candidate.
    expect(createTerrainResolver(BORDERED, "dirt")!.resolve(N | E | S | W)).toBe(5);
  });

  it("counts missing variants per set", () => {
    const fill = N | E | S | W;
    const openNorth = E | S | W;
    expect(missingTerrainVariants(BORDERED, "grass")).toHaveLength(14);
    expect(missingTerrainVariants(BORDERED, "grass")).not.toContain(fill);
    expect(missingTerrainVariants(BORDERED, "grass")).toContain(openNorth);
    expect(missingTerrainVariants(BORDERED, "grass", "dirt")).not.toContain(openNorth);
    expect(missingTerrainVariants(BORDERED, "grass", "dirt")).toContain(0);
    expect(missingTerrainVariants(BORDERED, "grass", "water")).toHaveLength(16);
    expect(missingTerrainVariants(BORDERED, "dirt")).toHaveLength(16);
    expect(missingTerrainVariants(BORDERED, "grass", "rock")).toEqual([]);
  });

  it("marks zones and fills layouts in one set at a time", () => {
    const tile = BORDERED.tiles[0]!;
    const moved = setAutotileZone(tile, "grass", N, true, "dirt");
    expect(moved.terrain).toEqual({ id: "grass", mask: N, border: "dirt" });
    expect(autotileZoneOn(moved, "grass", 0)).toBe(false);
    expect(autotileZoneOn(moved, "grass", N, "dirt")).toBe(true);
    // Turning a zone off in another set leaves the tile where it is.
    expect(setAutotileZone(moved, "grass", 0, false)).toBe(moved);
    expect(setAutotileZone(moved, "grass", N, true).terrain).toEqual({ id: "grass", mask: N });

    const sheet = ensureTilesetTiles(normalizeTilesetPayload({
      tileWidth: 16, tileHeight: 16, atlasWidth: 16 * 4, atlasHeight: 16 * 4,
      terrains: [{ id: "ground", name: "Ground", style: "sides", borders: ["rock"] }, { id: "rock", name: "Rock", style: "sides" }],
    }));
    const filled = applyAutotileLayout(sheet, "ground", 1, "rock");
    expect(filled.tiles[0]!.terrain).toEqual({ id: "ground", mask: E | S, border: "rock" });
    expect(missingTerrainVariants(filled, "ground", "rock")).toEqual([]);
    expect(applyAutotileLayout(sheet, "ground", 1, "lava")).toBe(sheet);
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

