import { describe, expect, it } from "vitest";
import {
  applyAutotileBlock,
  assignAutotilePiece,
  AUTOTILE_PIECE_GROUPS,
  AUTOTILE_PREVIEW_HEIGHT,
  AUTOTILE_PREVIEW_WIDTH,
  autotileBlockPlacement,
  autotileLayoutChange,
  autotilePieceTiles,
  autotilePreviewSample,
  autotilePreviewTiles,
  autotileReady,
  clearAutotilePiece,
  offsetAtlasTile,
  type AutotilePieceGroup,
} from "./tileset-autotile-templates";
import {
  AUTOTILE_LAYOUTS,
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
const INTO_WATER = { terrainId: "ground", border: "water" };

/** A `columns` × `rows` sheet of 16 px tiles with a Ground autotile (with a border into Water) and a Water autotile. */
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
    terrains: [{ id: "ground", name: "Ground", style, borders: ["water"] }, { id: "water", name: "Water", style: "sides" }],
  }));
  // Built after normalizing so test memberships may carry fields normalize does not know.
  return { ...base, tiles: base.tiles.map((tile) => (terrain[tile.id] ? { ...tile, terrain: terrain[tile.id] } : tile)) };
}

function memberships(tileset: TilesetPayload): Array<[number, string, number]> {
  return tileset.tiles.flatMap((tile) => (tile.terrain ? [[tile.id, tile.terrain.id, tile.terrain.mask] as [number, string, number]] : []));
}

function group(style: TilesetTerrainStyle, id: AutotilePieceGroup["id"]): AutotilePieceGroup {
  const found = AUTOTILE_PIECE_GROUPS[style].find((entry) => entry.id === id);
  if (!found) throw new Error(`No ${style} group ${id}`);
  return found;
}

/** The standard block for `style` assigned to Ground's default set from tile 1 of a sheet exactly that size. */
function standardSheet(style: TilesetTerrainStyle): TilesetPayload {
  const layout = AUTOTILE_LAYOUTS[style];
  return applyAutotileBlock(sheet(layout.columns, layout.rows, style), GROUND, layout, 1);
}

describe("piece groups", () => {
  it("gives 4 Sides one group of its 16 pieces in the standard block's order", () => {
    const [pieces, ...rest] = AUTOTILE_PIECE_GROUPS.sides;
    expect(rest).toEqual([]);
    expect(pieces).toMatchObject({ id: "pieces", title: "Pieces", columns: 4, optional: false });
    expect(pieces!.masks.slice(0, 4)).toEqual([E | S, E | S | W, S | W, S]);
    expect([...pieces!.masks].sort((a, b) => a - b)).toEqual(terrainVariantMasks("sides"));
  });

  it("splits Blob into Main, Inner Corners and an optional More Corners that cover each piece once", () => {
    expect(AUTOTILE_PIECE_GROUPS.blob.map((entry) => [entry.title, entry.masks.length, entry.optional])).toEqual([
      ["Main", 16, false], ["Inner Corners", 4, false], ["More Corners", 27, true],
    ]);
    // Main is the island with filled corners.
    expect(group("blob", "main").masks.slice(0, 4)).toEqual([E | S | SE, E | S | W | SE | SW, S | W | SW, S]);
    expect(group("blob", "main").masks[5]).toBe(TERRAIN_ALL);
    // Inner Corners: notches toward the centre of a 2 × 2 block around a hole.
    expect(group("blob", "inner-corners").masks).toEqual([TERRAIN_ALL & ~SE, TERRAIN_ALL & ~SW, TERRAIN_ALL & ~NE, TERRAIN_ALL & ~NW]);
    const all = AUTOTILE_PIECE_GROUPS.blob.flatMap((entry) => entry.masks);
    expect(new Set(all).size).toBe(47);
    expect([...all].sort((a, b) => a - b)).toEqual(terrainVariantMasks("blob"));
  });

  it("assigns a standard 12 × 4 Blob sheet with Main's block, then More Corners' block, which also holds the inner corners", () => {
    const tileset = sheet(12, 4, "blob");
    let next = applyAutotileBlock(tileset, GROUND, group("blob", "main").block, 1);
    next = applyAutotileBlock(next, GROUND, group("blob", "more-corners").block, 5);
    const pieces = autotilePieceTiles(next, GROUND);
    expect(pieces.size).toBe(47);
    // Every tile draws the piece the standard block puts there; its one empty cell (tile 48) stays empty.
    AUTOTILE_LAYOUTS.blob.masks.forEach((mask, at) => {
      if (mask === null) expect(next.tiles[at]!.terrain).toBeUndefined();
      else expect(pieces.get(mask)).toEqual([at + 1]);
    });
    expect(group("blob", "more-corners").block.masks.filter((mask) => mask !== null)).toHaveLength(31);
  });
});

describe("autotileReady", () => {
  it("needs every 4 Sides piece, or Blob's Main and Inner Corners, in the default set", () => {
    expect(autotileReady(standardSheet("sides"), "ground")).toBe(true);
    const missingOne = clearAutotilePiece(standardSheet("sides"), GROUND, 0);
    expect(autotileReady(missingOne, "ground")).toBe(false);

    let blob = applyAutotileBlock(sheet(6, 4, "blob"), GROUND, group("blob", "main").block, 1);
    expect(autotileReady(blob, "ground")).toBe(false);
    blob = applyAutotileBlock(blob, GROUND, group("blob", "inner-corners").block, 5);
    // More Corners is optional.
    expect(autotileReady(blob, "ground")).toBe(true);
    expect(autotileReady(blob, "water")).toBe(false);
    expect(autotileReady(blob, "lava")).toBe(false);
  });

  it("does not count border pieces or tiles past the atlas", () => {
    const border = applyAutotileBlock(sheet(4, 4, "sides"), INTO_WATER, AUTOTILE_LAYOUTS.sides, 1);
    expect(autotilePieceTiles(border, INTO_WATER).size).toBe(16);
    expect(autotileReady(border, "ground")).toBe(false);
    // Tile 16 drawn past a sheet that shrank to 4 × 3.
    const shrunk = { ...standardSheet("sides"), atlasHeight: 48 };
    expect(autotileReady(shrunk, "ground")).toBe(false);
  });
});

describe("autotileBlockPlacement", () => {
  it("places the block's cells from its top-left tile and leaves out the part past the sheet", () => {
    const tileset = sheet(5, 4, "blob");
    const inner = group("blob", "inner-corners").block;
    expect(autotileBlockPlacement(tileset, inner, 2)).toEqual([
      { tileId: 2, mask: TERRAIN_ALL & ~SE }, { tileId: 3, mask: TERRAIN_ALL & ~SW },
      { tileId: 7, mask: TERRAIN_ALL & ~NE }, { tileId: 8, mask: TERRAIN_ALL & ~NW },
    ]);
    // From the last column only the block's left column fits; from the last row only its top row.
    expect(autotileBlockPlacement(tileset, inner, 5).map((cell) => cell.tileId)).toEqual([5, 10]);
    expect(autotileBlockPlacement(tileset, inner, 17).map((cell) => cell.tileId)).toEqual([17, 18]);
    expect(autotileBlockPlacement(tileset, inner, 0)).toEqual([]);
    expect(autotileBlockPlacement(tileset, inner, 21)).toEqual([]);
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
    const border = assignAutotilePiece(tileset, INTO_WATER, W, 1);
    expect(border.tiles[0]!.terrain).toEqual({ id: "ground", mask: W, note: "kept", border: "water" });
    expect(autotilePieceTiles(tileset, GROUND)).toEqual(new Map([[0, [1]]]));
    expect(autotilePieceTiles(border, INTO_WATER)).toEqual(new Map([[W, [1]], [E, [2]]]));
    // Back into the default set, the tile drops its border.
    expect(assignAutotilePiece(border, GROUND, N, 1).tiles[0]!.terrain).toEqual({ id: "ground", mask: N, note: "kept" });
  });

  it("ignores an unknown autotile, an undeclared border or an unknown tile", () => {
    const tileset = sheet(2, 1, "blob");
    expect(assignAutotilePiece(tileset, { terrainId: "lava" }, 0, 1)).toBe(tileset);
    // Water declares no border, so it has no set drawn against Ground.
    expect(assignAutotilePiece(tileset, { terrainId: "water", border: "ground" }, 0, 1)).toBe(tileset);
    expect(applyAutotileBlock(tileset, { terrainId: "water", border: "ground" }, AUTOTILE_LAYOUTS.sides, 1)).toBe(tileset);
    expect(assignAutotilePiece(tileset, GROUND, 0, 9)).toBe(tileset);
  });
});

describe("clearAutotilePiece", () => {
  it("clears every tile of the set drawing a piece", () => {
    const tileset = sheet(4, 2, "sides", {
      1: { id: "ground", mask: E },
      2: { id: "ground", mask: E | NE },
      3: { id: "ground", mask: W },
      4: { id: "water", mask: E },
      5: { id: "ground", mask: E, border: "water" },
    });
    // Tile 2's corner does not count for 4 Sides, so it draws the same piece as tile 1.
    expect(autotilePieceTiles(tileset, GROUND).get(E)).toEqual([1, 2]);
    expect(memberships(clearAutotilePiece(tileset, GROUND, E))).toEqual([[3, "ground", W], [4, "water", E], [5, "ground", E]]);
    expect(clearAutotilePiece(tileset, GROUND, N)).toBe(tileset);
  });
});

describe("applyAutotileBlock", () => {
  it("assigns the block in one edit, moving tiles of other pieces and autotiles over", () => {
    const tileset = sheet(5, 4, "blob", {
      // Already the block's first piece where the block lands: unchanged.
      2: { id: "ground", mask: TERRAIN_ALL & ~SE },
      // A Ground tile outside the block drawing one of its pieces: it leaves.
      20: { id: "ground", mask: TERRAIN_ALL & ~NW },
      // A Water tile under the block: it moves to Ground.
      3: { id: "water", mask: N },
    });
    const next = applyAutotileBlock(tileset, GROUND, group("blob", "inner-corners").block, 2);
    expect(memberships(next)).toEqual([
      [2, "ground", TERRAIN_ALL & ~SE], [3, "ground", TERRAIN_ALL & ~SW],
      [7, "ground", TERRAIN_ALL & ~NE], [8, "ground", TERRAIN_ALL & ~NW],
    ]);
    expect(applyAutotileBlock(next, GROUND, group("blob", "inner-corners").block, 2)).toBe(next);
  });

  it("assigns only the part of a block that fits on the sheet", () => {
    const next = applyAutotileBlock(sheet(3, 2, "sides"), GROUND, AUTOTILE_LAYOUTS.sides, 2);
    // Columns 2-3 of rows 1-2: the block's first two columns, top two rows.
    expect(memberships(next)).toEqual([
      [2, "ground", E | S | SE], [3, "ground", E | S | W | SE | SW],
      [5, "ground", N | E | S | NE | SE], [6, "ground", TERRAIN_ALL],
    ]);
  });
});

describe("autotileLayoutChange", () => {
  it("reports the pieces a Layout switch keeps, misses and leaves unused", () => {
    // 47 Blob pieces read as 16 4 Sides pieces; the other 31 tiles repeat one of them.
    const toSides = autotileLayoutChange(standardSheet("blob"), GROUND, "sides");
    expect(toSides.kept).toBe(16);
    expect(toSides.missing).toBe(0);
    expect(toSides.unusedTileIds).toHaveLength(31);
    // Painting keeps the lowest tile of each piece, so the block's first tile stays in use.
    expect(toSides.unusedTileIds).not.toContain(1);
    expect(autotileLayoutChange(standardSheet("sides"), GROUND, "blob")).toEqual({ kept: 16, missing: 31, unusedTileIds: [] });
  });
});

describe("preview", () => {
  const key = (x: number, y: number) => `${x},${y}`;
  const size = { width: AUTOTILE_PREVIEW_WIDTH, height: AUTOTILE_PREVIEW_HEIGHT };
  const cellsOf = (sample: Array<{ x: number; y: number; terrainId: string }>) =>
    new Map(sample.map((cell) => [key(cell.x, cell.y), cell.terrainId]));

  it("samples an island with a hole, strips and a single for Blob, and strips for 4 Sides", () => {
    const blob = cellsOf(autotilePreviewSample("blob", GROUND));
    // The island's top row runs from column 1 to 7, two rows below the map's top edge.
    expect(blob.get(key(1, 5))).toBe("ground");
    expect(blob.get(key(7, 5))).toBe("ground");
    expect(blob.get(key(8, 5))).toBeUndefined();
    // Its hole, the single and the strip along the bottom row.
    expect(blob.get(key(3, 4))).toBeUndefined();
    expect(blob.get(key(9, 0))).toBe("ground");
    expect(blob.get(key(1, 0))).toBe("ground");
    const sides = cellsOf(autotilePreviewSample("sides", GROUND));
    expect([...sides.keys()].sort()).toEqual([
      "10,3", "2,5", "3,1", "3,5", "4,1", "4,5", "5,5", "6,5", "7,3", "7,5", "8,3", "9,1", "9,3",
    ]);
  });

  it("samples a border set as the autotile inside a field of its border autotile", () => {
    const sample = autotilePreviewSample("blob", INTO_WATER);
    expect(sample).toHaveLength(AUTOTILE_PREVIEW_WIDTH * AUTOTILE_PREVIEW_HEIGHT);
    const cells = cellsOf(sample);
    expect(cells.get(key(0, 6))).toBe("water");
    expect(cells.get(key(2, 5))).toBe("ground");
    expect(cells.get(key(8, 3))).toBe("ground");
    expect(cells.get(key(9, 3))).toBe("water");
  });

  it.each(["sides", "blob"] as const)(
    "paints the %s sample with an exact piece in every cell once the standard block is assigned",
    (style) => {
      const tileset = standardSheet(style);
      const sample = autotilePreviewSample(style, GROUND);
      const tiles = autotilePreviewTiles(tileset, GROUND, sample, size);
      expect(tiles.size).toBe(sample.length);
      const pieceOf = autotilePieceTiles(tileset, GROUND);
      for (const tile of tiles.values()) {
        expect(tile.standIn).toBe(false);
        expect(tile.border).toBeUndefined();
        expect(pieceOf.get(tile.want!)).toEqual([tile.tileId]);
      }
    },
  );

  it("joins terrain past the preview's edge, as a Tilemap does at its own", () => {
    const tiles = autotilePreviewTiles(standardSheet("blob"), GROUND, autotilePreviewSample("blob", GROUND), size);
    // The bottom strip and the single lie on the preview's bottom row: they continue below it.
    expect(tiles.get(key(1, 0))!.want).toBe(E | S | SE);
    expect(tiles.get(key(3, 0))!.want).toBe(E | S | W | SE | SW);
    expect(tiles.get(key(9, 0))!.want).toBe(S);
    // Around the hole: the island's top edge above it is a row middle, below-right is a single inner corner.
    expect(tiles.get(key(3, 5))!.want).toBe(E | W);
    expect(tiles.get(key(4, 3))!.want).toBe(TERRAIN_ALL & ~NW);
    expect(tiles.get(key(2, 3))!.want).toBe(N | E | S | W | SE | NW);
    expect(autotilePreviewTiles(standardSheet("blob"), GROUND, [{ x: 12, y: 0, terrainId: "ground" }], size).size).toBe(0);
  });

  it("marks stand-ins and reports the piece each cell wants", () => {
    // Only Main: the hole's notches stand in.
    const tileset = applyAutotileBlock(sheet(4, 4, "blob"), GROUND, group("blob", "main").block, 1);
    const tiles = autotilePreviewTiles(tileset, GROUND, autotilePreviewSample("blob", GROUND), size);
    expect(tiles.get(key(4, 3))).toMatchObject({ want: TERRAIN_ALL & ~NW, standIn: true });
    // The island's top-left corner has its exact piece: tile 1.
    expect(tiles.get(key(1, 5))).toEqual({ terrainId: "ground", tileId: 1, want: E | S | SE, standIn: false });
  });

  it("reports the wanted pieces of an autotile without tiles, which draws nothing", () => {
    const tiles = autotilePreviewTiles(sheet(4, 4, "blob"), GROUND, autotilePreviewSample("blob", GROUND), size);
    expect(tiles.get(key(1, 5))).toEqual({ terrainId: "ground", tileId: 0, want: E | S | SE, standIn: true });
    expect(tiles.get(key(4, 3))).toEqual({ terrainId: "ground", tileId: 0, want: TERRAIN_ALL & ~NW, standIn: true });
  });

  /**
   * A 4 × 9 sheet: Ground's 4 Sides block in rows 1-4, its island drawn
   * against Water in rows 5-7 (tiles 17-19, 21-23, 25-27), and one Water tile.
   */
  function transitionSheet(): TilesetPayload {
    const island: Array<[number, number]> = [
      [17, E | S], [18, E | S | W], [19, S | W], [21, N | E | S], [22, N | E | S | W], [23, N | S | W], [25, N | E], [26, N | E | W], [27, N | W],
    ];
    let tileset = applyAutotileBlock(sheet(4, 9, "sides"), GROUND, AUTOTILE_LAYOUTS.sides, 1);
    for (const [tileId, mask] of island) tileset = assignAutotilePiece(tileset, INTO_WATER, mask, tileId);
    return assignAutotilePiece(tileset, { terrainId: "water" }, N | E | S | W, 33);
  }

  it("paints a transition as the Tilemap brush does: Ground draws the seam from its border set, Water runs under it", () => {
    const tiles = autotilePreviewTiles(transitionSheet(), INTO_WATER, autotilePreviewSample("sides", INTO_WATER), size);
    // The island's top-left faces Water on two sides: the border set's E | S piece, tile 17.
    expect(tiles.get(key(2, 5))).toEqual({ terrainId: "ground", tileId: 17, want: E | S, border: "water", standIn: false });
    // Inside the island every side joins: the ordinary fill, tile 6.
    expect(tiles.get(key(4, 3))).toEqual({ terrainId: "ground", tileId: 6, want: N | E | S | W, standIn: false });
    // Water beside Ground joins toward it, because Ground's pieces draw the seam.
    expect(tiles.get(key(1, 5))).toEqual({ terrainId: "water", tileId: 33, want: N | E | S | W, standIn: false });
    // At the preview's corner Water continues past both edges, as on a Tilemap: its own fill.
    expect(tiles.get(key(0, 6))).toEqual({ terrainId: "water", tileId: 33, want: N | E | S | W, standIn: false });
  });

  it("wants an empty border set's pieces where the autotile faces its border, while drawing the ordinary ones", () => {
    const tileset = applyAutotileBlock(sheet(4, 4, "sides"), GROUND, AUTOTILE_LAYOUTS.sides, 1);
    const tiles = autotilePreviewTiles(tileset, INTO_WATER, autotilePreviewSample("sides", INTO_WATER), size);
    // Painting uses Ground's ordinary top-left corner (tile 1); the cell is waiting for the border's E | S piece.
    expect(tiles.get(key(2, 5))).toEqual({ terrainId: "ground", tileId: 1, want: E | S, border: "water", standIn: true });
    // Water has no tiles: it draws nothing but still joins toward Ground.
    expect(tiles.get(key(1, 5))).toEqual({ terrainId: "water", tileId: 0, want: N | E | S | W, standIn: true });
    // The default set is unaffected: a default-set preview of the same sheet keeps Ground's ordinary pieces.
    const plain = autotilePreviewTiles(tileset, GROUND, [{ x: 2, y: 5, terrainId: "ground" }], size);
    expect(plain.get(key(2, 5))).toEqual({ terrainId: "ground", tileId: 16, want: 0, standIn: false });
  });

  it("reports nothing wanted for an autotile the Tileset does not have", () => {
    const tiles = autotilePreviewTiles(standardSheet("sides"), GROUND, [{ x: 1, y: 1, terrainId: "lava" }], size);
    expect(tiles.get(key(1, 1))).toEqual({ terrainId: "lava", tileId: 0, want: null, standIn: false });
  });
});
