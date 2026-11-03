import { describe, expect, it } from "vitest";
import {
  applyAutotileTemplate,
  assignAutotilePiece,
  AUTOTILE_SANDBOX_HEIGHT,
  AUTOTILE_SANDBOX_WIDTH,
  AUTOTILE_TEMPLATES,
  autotileLayoutChange,
  autotilePieceOfTile,
  autotilePieceTiles,
  autotileSandboxSample,
  autotileSandboxTiles,
  autotileTemplateFits,
  autotileTemplatePlacement,
  clearAutotilePiece,
  offsetAtlasTile,
  removeTileFromAutotile,
  type AutotileTemplate,
} from "./tileset-autotile-templates";
import {
  canonicalTerrainMask,
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

const GROUND = { terrainId: "ground" };

/** A `columns` × `rows` sheet of 16 px tiles with a Ground autotile and a Water autotile. */
function sheet(
  columns: number,
  rows: number,
  style: TilesetTerrainStyle,
  terrain: Record<number, { id: string; mask: number } & Record<string, unknown>> = {},
): TilesetPayload {
  const base = ensureTilesetTiles(normalizeTilesetPayload({
    atlasWidth: columns * 16,
    atlasHeight: rows * 16,
    tileWidth: 16,
    tileHeight: 16,
    terrains: [{ id: "ground", name: "Ground", style }, { id: "water", name: "Water", style: "sides" }],
  }));
  // Built after normalizing so test memberships may carry fields normalize does not know.
  return { ...base, tiles: base.tiles.map((tile) => (terrain[tile.id] ? { ...tile, terrain: terrain[tile.id] } : tile)) };
}

function memberships(tileset: TilesetPayload): Array<[number, string, number]> {
  return tileset.tiles.flatMap((tile) => (tile.terrain ? [[tile.id, tile.terrain.id, tile.terrain.mask] as [number, string, number]] : []));
}

function template(style: TilesetTerrainStyle, id: string): AutotileTemplate {
  const found = AUTOTILE_TEMPLATES[style].find((entry) => entry.id === id);
  if (!found) throw new Error(`No ${style} template ${id}`);
  return found;
}

/**
 * The mask a cell of a solid `columns` × `rows` block draws: a neighbour bit
 * wherever the neighbour lies inside the block (row 0 is the top, so north is
 * the row above), read in the style's canonical form.
 */
function solidBlockMask(style: TilesetTerrainStyle, columns: number, rows: number, at: number): number {
  const column = at % columns;
  const row = Math.floor(at / columns);
  const offsets: Array<[number, number, number]> = [
    [N, 0, -1], [NE, 1, -1], [E, 1, 0], [SE, 1, 1], [S, 0, 1], [SW, -1, 1], [W, -1, 0], [NW, -1, -1],
  ];
  let mask = 0;
  for (const [bit, dx, dy] of offsets) {
    const x = column + dx;
    const y = row + dy;
    if (x >= 0 && y >= 0 && x < columns && y < rows) mask |= bit;
  }
  return canonicalTerrainMask(style, mask);
}

describe("autotile templates", () => {
  it.each(["sides", "blob"] as const)("lists only canonical, distinct %s masks and a full block covering every piece", (style) => {
    for (const entry of AUTOTILE_TEMPLATES[style]) {
      const masks = entry.masks.filter((mask): mask is number => mask !== null);
      expect(entry.masks).toHaveLength(entry.columns * entry.rows);
      for (const mask of masks) expect(canonicalTerrainMask(style, mask)).toBe(mask);
      expect(new Set(masks).size).toBe(masks.length);
    }
    const block = AUTOTILE_TEMPLATES[style][0]!;
    expect([...block.masks].filter((mask) => mask !== null).sort((a, b) => a! - b!)).toEqual(terrainVariantMasks(style));
  });

  it("names each style's templates in order, full block first", () => {
    expect(AUTOTILE_TEMPLATES.sides.map((entry) => entry.title)).toEqual([
      "4 Sides Block (4 × 4)", "Island (3 × 3)", "Horizontal Strip (3 × 1)", "Vertical Strip (1 × 3)", "Single (1 × 1)",
    ]);
    expect(AUTOTILE_TEMPLATES.blob.map((entry) => entry.title)).toEqual([
      "Blob Block (12 × 4)", "Island (3 × 3)", "Horizontal Strip (3 × 1)", "Vertical Strip (1 × 3)", "Single (1 × 1)",
      "Inner Corners, Hole (2 × 2)", "Inner Corners, Outward (2 × 2)",
    ]);
  });

  it.each([
    ["sides", "island"], ["sides", "horizontal-strip"], ["sides", "vertical-strip"], ["sides", "single"],
    ["blob", "island"], ["blob", "horizontal-strip"], ["blob", "vertical-strip"], ["blob", "single"],
  ] as const)("draws the %s %s cells as the parts of one solid block", (style, id) => {
    const entry = template(style, id);
    entry.masks.forEach((mask, at) => expect(mask).toBe(solidBlockMask(style, entry.columns, entry.rows, at)));
  });

  it("gives the Blob island filled corners and the 4 Sides island none", () => {
    expect(template("blob", "island").masks.slice(0, 3)).toEqual([E | S | SE, E | S | W | SE | SW, S | W | SW]);
    expect(template("blob", "island").masks[4]).toBe(TERRAIN_ALL);
    expect(template("sides", "island").masks.slice(0, 3)).toEqual([E | S, E | S | W, S | W]);
  });

  it("points the 2 × 2 inner corners at the block's centre for Hole and away from it for Outward", () => {
    expect(template("blob", "inner-corners-hole").masks).toEqual([
      TERRAIN_ALL & ~SE, TERRAIN_ALL & ~SW,
      TERRAIN_ALL & ~NE, TERRAIN_ALL & ~NW,
    ]);
    expect(template("blob", "inner-corners-outward").masks).toEqual([
      TERRAIN_ALL & ~NW, TERRAIN_ALL & ~NE,
      TERRAIN_ALL & ~SW, TERRAIN_ALL & ~SE,
    ]);
  });
});

describe("autotileTemplatePlacement", () => {
  it("places the block's cells from its top-left tile and refuses one that runs past the sheet", () => {
    const tileset = sheet(5, 4, "blob");
    const island = template("blob", "island");
    expect(autotileTemplatePlacement(tileset, island, 2)?.map((cell) => cell.tileId)).toEqual([2, 3, 4, 7, 8, 9, 12, 13, 14]);
    // Column 4 of 5 leaves two columns: too narrow for three.
    expect(autotileTemplatePlacement(tileset, island, 4)).toBeNull();
    // Row 3 of 4 leaves two rows.
    expect(autotileTemplatePlacement(tileset, island, 11)).toBeNull();
    expect(autotileTemplatePlacement(tileset, island, 0)).toBeNull();
    expect(autotileTemplateFits(tileset, island)).toBe(true);
    expect(autotileTemplateFits(tileset, template("blob", "blob-block"))).toBe(false);
  });

  it("steps across the sheet without wrapping rows", () => {
    const tileset = sheet(5, 4, "blob");
    expect(offsetAtlasTile(tileset, 5, 1, 0)).toBeNull();
    expect(offsetAtlasTile(tileset, 5, -1, 1)).toBe(9);
    expect(offsetAtlasTile(tileset, 1, 0, -1)).toBeNull();
    expect(offsetAtlasTile(tileset, 20, 0, 1)).toBeNull();
  });
});

describe("assignAutotilePiece", () => {
  it("keeps one tile per piece: another Ground tile drawing it leaves, a Water tile moves over", () => {
    const tileset = sheet(4, 2, "blob", {
      1: { id: "ground", mask: E | S | SE },
      2: { id: "ground", mask: TERRAIN_ALL },
      3: { id: "water", mask: N },
    });
    const next = assignAutotilePiece(tileset, GROUND, E | S | SE, 3);
    expect(memberships(next)).toEqual([[2, "ground", TERRAIN_ALL], [3, "ground", E | S | SE]]);
    // Assigning a tile its own piece changes nothing.
    expect(assignAutotilePiece(next, GROUND, E | S | SE | NW, 3)).toBe(next);
    expect(autotilePieceOfTile(next, GROUND, 3)).toBe(E | S | SE);
    expect(autotilePieceOfTile(next, GROUND, 1)).toBeNull();
  });

  it("stores 4 Sides pieces with filled corners, so Blob reads them as the solid island", () => {
    const tileset = sheet(4, 2, "sides");
    const next = assignAutotilePiece(tileset, GROUND, E | S, 1);
    expect(memberships(next)).toEqual([[1, "ground", E | S | SE]]);
    expect(autotilePieceTiles(next, GROUND)).toEqual(new Map([[E | S, [1]]]));
  });

  it("keeps a membership's other fields and writes the set's border", () => {
    const tileset = sheet(4, 2, "blob", {
      1: { id: "ground", mask: 0, note: "kept" },
      2: { id: "ground", mask: E, border: "water" },
    });
    const own = assignAutotilePiece(tileset, GROUND, TERRAIN_ALL, 1);
    expect(own.tiles[0]!.terrain).toEqual({ id: "ground", mask: TERRAIN_ALL, note: "kept" });
    // A border piece of the same terrain is another set: assigning Ground's own E piece leaves it alone.
    const plain = assignAutotilePiece(tileset, GROUND, E, 3);
    expect(plain.tiles[1]!.terrain).toEqual({ id: "ground", mask: E, border: "water" });
    const border = assignAutotilePiece(tileset, { terrainId: "ground", border: "water" }, W, 1);
    expect(border.tiles[0]!.terrain).toEqual({ id: "ground", mask: W, note: "kept", border: "water" });
    expect(autotilePieceTiles(tileset, GROUND)).toEqual(new Map([[0, [1]]]));
  });

  it("ignores an unknown autotile or tile", () => {
    const tileset = sheet(2, 1, "blob");
    expect(assignAutotilePiece(tileset, { terrainId: "lava" }, 0, 1)).toBe(tileset);
    expect(assignAutotilePiece(tileset, GROUND, 0, 9)).toBe(tileset);
  });
});

describe("clearing pieces", () => {
  it("clears every tile drawing a piece, and removes one tile only from its own set", () => {
    const tileset = sheet(4, 2, "sides", {
      1: { id: "ground", mask: E },
      2: { id: "ground", mask: E | NE },
      3: { id: "ground", mask: W },
      4: { id: "water", mask: E },
    });
    // Tile 2's corner does not count for 4 Sides, so it draws the same piece as tile 1.
    expect(autotilePieceTiles(tileset, GROUND).get(E)).toEqual([1, 2]);
    expect(memberships(clearAutotilePiece(tileset, GROUND, E))).toEqual([[3, "ground", W], [4, "water", E]]);
    expect(clearAutotilePiece(tileset, GROUND, N)).toBe(tileset);
    expect(memberships(removeTileFromAutotile(tileset, GROUND, 3))).toEqual([[1, "ground", E], [2, "ground", E | NE], [4, "water", E]]);
    expect(removeTileFromAutotile(tileset, GROUND, 4)).toBe(tileset);
  });
});

describe("applyAutotileTemplate", () => {
  it("assigns the block in one edit and counts the memberships it replaces", () => {
    const tileset = sheet(5, 4, "blob", {
      // Already the island's top-left piece where the block lands: unchanged, not counted.
      2: { id: "ground", mask: E | S | SE },
      // A Ground tile outside the block drawing the island's centre: it leaves.
      20: { id: "ground", mask: TERRAIN_ALL },
      // A Water tile under the block: it moves to Ground.
      3: { id: "water", mask: N },
      // A Ground tile under the block drawing another piece: reassigned.
      7: { id: "ground", mask: 0 },
    });
    const result = applyAutotileTemplate(tileset, GROUND, template("blob", "island"), 2)!;
    expect(result.pieces).toBe(9);
    expect(result.replaced).toBe(3);
    expect(memberships(result.next)).toEqual([
      [2, "ground", E | S | SE], [3, "ground", E | S | W | SE | SW], [4, "ground", S | W | SW],
      [7, "ground", N | E | S | NE | SE], [8, "ground", TERRAIN_ALL], [9, "ground", N | S | W | NW | SW],
      [12, "ground", N | E | NE], [13, "ground", N | E | W | NE | NW], [14, "ground", N | W | NW],
    ]);
    expect(applyAutotileTemplate(tileset, GROUND, template("blob", "island"), 4)).toBeNull();
  });

  it("leaves the Blob block's empty cell and the tile under it alone", () => {
    const tileset = sheet(12, 4, "blob", { 48: { id: "water", mask: 0 } });
    const result = applyAutotileTemplate(tileset, GROUND, template("blob", "blob-block"), 1)!;
    expect(result.pieces).toBe(47);
    expect(result.replaced).toBe(0);
    expect(result.next.tiles[47]!.terrain).toEqual({ id: "water", mask: 0 });
    expect(autotilePieceTiles(result.next, GROUND).size).toBe(47);
  });
});

describe("autotileLayoutChange", () => {
  it("reports the pieces a Layout switch keeps, misses and leaves unused", () => {
    const blob = applyAutotileTemplate(sheet(12, 4, "blob"), GROUND, template("blob", "blob-block"), 1)!.next;
    // 47 Blob pieces read as 16 4 Sides pieces; the other 31 tiles repeat one of them.
    const toSides = autotileLayoutChange(blob, GROUND, "sides");
    expect(toSides.kept).toBe(16);
    expect(toSides.missing).toBe(0);
    expect(toSides.unusedTileIds).toHaveLength(31);
    // Painting keeps the lowest tile of each piece, so the block's first tile stays in use.
    expect(toSides.unusedTileIds).not.toContain(1);

    const sides = applyAutotileTemplate(sheet(4, 4, "sides"), GROUND, template("sides", "sides-block"), 1)!.next;
    expect(autotileLayoutChange(sides, GROUND, "blob")).toEqual({ kept: 16, missing: 31, unusedTileIds: [] });
  });
});

describe("test paint", () => {
  it("samples an island, strips and a single inside the map, with a hole for Blob", () => {
    const sides = autotileSandboxSample("sides");
    const blob = autotileSandboxSample("blob");
    const key = (cell: { x: number; y: number }) => `${cell.x},${cell.y}`;
    expect(blob).toHaveLength(sides.length - 1);
    // The hole sits in the island's middle: row 3 from the top, column 3.
    expect(sides.map(key)).toContain("3,5");
    expect(blob.map(key)).not.toContain("3,5");
    for (const cell of sides) {
      expect(cell.x).toBeGreaterThan(0);
      expect(cell.y).toBeGreaterThan(0);
      expect(cell.x).toBeLessThan(AUTOTILE_SANDBOX_WIDTH - 1);
      expect(cell.y).toBeLessThan(AUTOTILE_SANDBOX_HEIGHT - 1);
    }
  });

  const size = { width: AUTOTILE_SANDBOX_WIDTH, height: AUTOTILE_SANDBOX_HEIGHT };

  it.each([
    ["sides", "sides-block", 4, 4],
    ["blob", "blob-block", 12, 4],
  ] as const)("paints the %s sample with an exact piece in every cell once the full block is assigned", (style, id, columns, rows) => {
    const tileset = applyAutotileTemplate(sheet(columns, rows, style), GROUND, template(style, id), 1)!.next;
    const tiles = autotileSandboxTiles(tileset, GROUND, autotileSandboxSample(style), size);
    expect(tiles.size).toBe(autotileSandboxSample(style).length);
    for (const tile of tiles.values()) {
      expect(tile.standIn).toBe(false);
      expect(autotilePieceOfTile(tileset, GROUND, tile.tileId)).toBe(tile.want);
    }
    // 4 Sides' sample draws every one of its 16 pieces.
    if (style === "sides") expect(new Set([...tiles.values()].map((tile) => tile.want)).size).toBe(16);
  });

  it("marks stand-ins and reports the piece each cell wanted", () => {
    // Only the Blob island: strips, the single and the hole's notches stand in.
    const tileset = applyAutotileTemplate(sheet(5, 4, "blob"), GROUND, template("blob", "island"), 1)!.next;
    const tiles = autotileSandboxTiles(tileset, GROUND, autotileSandboxSample("blob"), size);
    // The single at column 11, three rows from the top.
    expect(tiles.get("11,5")).toMatchObject({ want: 0, standIn: true });
    // Above-left of the hole: everything joins but the hole's diagonal.
    expect(tiles.get("2,6")).toMatchObject({ want: TERRAIN_ALL & ~SE, standIn: true });
    // The island's top-left corner has its exact piece: tile 1.
    expect(tiles.get("1,7")).toEqual({ tileId: 1, want: E | S | SE, standIn: false });
  });

  it("joins past the map edge and draws nothing for a terrain without tiles", () => {
    const tileset = applyAutotileTemplate(sheet(4, 4, "sides"), GROUND, template("sides", "sides-block"), 1)!.next;
    const corner = autotileSandboxTiles(tileset, GROUND, [{ x: 0, y: 0 }], size).get("0,0")!;
    expect(corner.want).toBe(S | W);
    const empty = autotileSandboxTiles(sheet(4, 4, "sides"), GROUND, [{ x: 4, y: 4 }], size).get("4,4");
    expect(empty).toEqual({ tileId: 0, want: 0, standIn: false });
  });
});
