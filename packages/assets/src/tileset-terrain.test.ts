import { describe, expect, it } from "vitest";
import {
  canonicalTerrainMask,
  createTerrainResolver,
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
import { normalizeTilesetPayload, type TilesetPayload, type TilesetTerrainStyle } from "./tileset-payload";

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
