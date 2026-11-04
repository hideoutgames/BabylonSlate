import { describe, expect, it } from "vitest";
import {
  AUTOTILE_LAYOUTS,
  cachedTerrainResolver,
  canonicalTerrainMask,
  createTerrainResolver,
  missingTerrainVariants,
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
  tilesetTerrainStamp,
} from "./tileset-terrain";
import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
  setTilesetTerrains,
  type TilesetPayload,
  type TilesetTerrainStyle,
} from "./tileset-payload";

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

describe("cachedTerrainResolver", () => {
  it("shares one resolver per Tileset payload, terrain and member limit, and builds a new one for an edited payload", () => {
    const sheet = terrainSheet("sides", [0, E, E | W, W]);
    const shared = cachedTerrainResolver(sheet, "ground");
    expect(cachedTerrainResolver(sheet, "ground")).toBe(shared);
    expect(shared!.resolve(E | W)).toBe(3);
    // A map range that ends before the middle piece resolves without it.
    const limited = cachedTerrainResolver(sheet, "ground", 2);
    expect(limited).not.toBe(shared);
    expect(limited!.resolve(E | W)).toBe(2);
    expect(cachedTerrainResolver(sheet, "missing")).toBeNull();
    // An edit replaces the payload object, so its terrains resolve afresh.
    const edited = terrainSheet("sides", [0, E, W, E | W]);
    expect(cachedTerrainResolver(edited, "ground")!.resolve(E | W)).toBe(4);
  });
});

describe("tilesetTerrainStamp", () => {
  it("depends only on what terrain resolution reads", () => {
    const stamp = tilesetTerrainStamp(BORDERED);
    // A copy decoded again, padded with empty tiles, renamed, reordered, with other tile data.
    const same = normalizeTilesetPayload({
      ...BORDERED,
      terrains: [...BORDERED.terrains!].reverse().map((terrain) => ({ ...terrain, name: `${terrain.name} 2`, borders: [...(terrain.borders ?? [])].reverse() })),
      tiles: [...BORDERED.tiles].reverse().map((tile) => ({ ...tile, collision: "full", flags: 3 })),
    });
    expect(tilesetTerrainStamp(same)).toBe(stamp);
    expect(tilesetTerrainStamp(ensureTilesetTiles(BORDERED))).toBe(stamp);
    // Tile 6 lies past the atlas, so its membership never counts.
    const pastAtlas = { ...BORDERED, tiles: BORDERED.tiles.map((tile) => (tile.id === 6 ? { ...tile, terrain: { id: "grass", mask: 0 } } : tile)) };
    expect(tilesetTerrainStamp(pastAtlas)).toBe(stamp);
  });

  it("changes with any terrain's style or borders and any member tile's set or mask", () => {
    const retile = (id: number, terrain: TilesetPayload["tiles"][number]["terrain"]): TilesetPayload => ({
      ...BORDERED,
      tiles: BORDERED.tiles.map((tile) => (tile.id === id ? { ...tile, terrain } : tile)),
    });
    const changes = [
      setTilesetTerrains(BORDERED, BORDERED.terrains!.map((terrain) => (terrain.id === "water" ? { ...terrain, style: "blob" as const } : terrain))),
      setTilesetTerrains(BORDERED, BORDERED.terrains!.map((terrain) => (terrain.id === "grass" ? { ...terrain, borders: ["dirt"] } : terrain))),
      retile(1, { id: "grass", mask: N }),
      retile(1, { id: "grass", mask: 0, border: "dirt" }),
      retile(1, { id: "dirt", mask: 0, border: "grass" }),
      retile(1, undefined),
    ];
    const stamps = new Set([BORDERED, ...changes].map(tilesetTerrainStamp));
    expect(stamps.size).toBe(changes.length + 1);
  });

  it("gives every Tileset without terrains the same stamp", () => {
    const plain = normalizeTilesetPayload({ atlasWidth: 32, tiles: [{ id: 1, collision: "full" }] });
    expect(tilesetTerrainStamp(plain)).toBe(tilesetTerrainStamp(normalizeTilesetPayload({})));
    expect(tilesetTerrainStamp(plain)).not.toBe(tilesetTerrainStamp(terrainSheet("sides", [])));
  });
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
});

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
});

