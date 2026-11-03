/**
 * Autotile authoring helpers for the Tileset Autotiles window (Babylon-free):
 * piece sets, one-tile-per-piece assignment, sheet templates and their
 * placement, Layout change summaries and the test-paint sandbox.
 */

import {
  AUTOTILE_LAYOUTS,
  canonicalTerrainMask,
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NEIGHBOURS,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SIDES,
  TERRAIN_SW,
  TERRAIN_W,
  terrainVariantMasks,
} from "./tileset-terrain";
import {
  tilesetAtlasColumns,
  tilesetAtlasRows,
  tilesetTerrainById,
  type TilesetPayload,
  type TilesetTerrainStyle,
  type TilesetTile,
  type TilesetTileTerrain,
} from "./tileset-payload";
import { createTilemapLayer, getTile, type TilemapPayload } from "./tilemap-payload";
import { paintTilemapTerrain } from "./tilemap-terrain";

/**
 * The pieces one autotile draws: a terrain's own pieces, or (with `border`)
 * the pieces it draws where it meets another terrain. A tile belongs to a set
 * when its membership has the set's terrain and border.
 */
export interface AutotilePieceSet {
  terrainId: string;
  border?: string;
}

/** The border a membership draws; `undefined` for a terrain's own pieces. */
function membershipBorder(terrain: TilesetTileTerrain): string | undefined {
  const border = (terrain as TilesetTileTerrain & { border?: unknown }).border;
  return typeof border === "string" ? border : undefined;
}

/** Whether a tile membership is one of the set's pieces. */
export function autotilePieceSetHas(set: AutotilePieceSet, terrain: TilesetTileTerrain | undefined): boolean {
  return terrain?.id === set.terrainId && membershipBorder(terrain) === set.border;
}

/**
 * The mask a piece stores. 4 Sides pieces store their corners filled, so a
 * set switched to Blob reads its 16 pieces as the solid-cornered island
 * shapes rather than as inner-corner notches.
 */
function storedPieceMask(style: TilesetTerrainStyle, canonical: number): number {
  return style === "sides" ? withFilledCorners(canonical) : canonical;
}

const CORNERS: ReadonlyArray<{ bit: number; sides: number }> = [
  { bit: TERRAIN_NE, sides: TERRAIN_N | TERRAIN_E },
  { bit: TERRAIN_SE, sides: TERRAIN_S | TERRAIN_E },
  { bit: TERRAIN_SW, sides: TERRAIN_S | TERRAIN_W },
  { bit: TERRAIN_NW, sides: TERRAIN_N | TERRAIN_W },
];

function withFilledCorners(mask: number): number {
  let filled = mask & TERRAIN_SIDES;
  for (const corner of CORNERS) if ((filled & corner.sides) === corner.sides) filled |= corner.bit;
  return filled;
}

/** The membership a tile takes in `set`: other fields of its current membership stay. */
function pieceMembership(set: AutotilePieceSet, current: TilesetTileTerrain | undefined, mask: number): TilesetTileTerrain {
  const next: TilesetTileTerrain & { border?: string } = { ...current, id: set.terrainId, mask };
  if (set.border === undefined) delete next.border;
  else next.border = set.border;
  return next;
}

function withoutTerrain(tile: TilesetTile): TilesetTile {
  const next = { ...tile };
  delete next.terrain;
  return next;
}

/**
 * The set's tiles by canonical mask, each list in tile id order: painting
 * uses the first tile of a mask, so any later one is unused.
 */
export function autotilePieceTiles(tileset: TilesetPayload, set: AutotilePieceSet): Map<number, number[]> {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  const pieces = new Map<number, number[]>();
  if (!terrain) return pieces;
  const members = tileset.tiles.filter((tile) => autotilePieceSetHas(set, tile.terrain)).sort((a, b) => a.id - b.id);
  for (const tile of members) {
    const mask = canonicalTerrainMask(terrain.style, tile.terrain!.mask);
    const tiles = pieces.get(mask);
    if (tiles) tiles.push(tile.id);
    else pieces.set(mask, [tile.id]);
  }
  return pieces;
}

/** The canonical piece a tile draws in the set, or `null` outside it. */
export function autotilePieceOfTile(tileset: TilesetPayload, set: AutotilePieceSet, tileId: number): number | null {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  const tile = tileset.tiles.find((entry) => entry.id === tileId);
  if (!terrain || !tile?.terrain || !autotilePieceSetHas(set, tile.terrain)) return null;
  return canonicalTerrainMask(terrain.style, tile.terrain.mask);
}

/**
 * Make `tileId` the set's tile for the piece `mask` (any mask; its canonical
 * form for the set's style counts). One tile per piece: every other tile of
 * the set drawing that piece leaves the autotile, and a tile of another
 * autotile moves over. Returns `tileset` itself when nothing changes.
 */
export function assignAutotilePiece(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  mask: number,
  tileId: number,
): TilesetPayload {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  if (!terrain || !tileset.tiles.some((tile) => tile.id === tileId)) return tileset;
  const want = canonicalTerrainMask(terrain.style, mask);
  let changed = false;
  const tiles = tileset.tiles.map((tile) => {
    const member = autotilePieceSetHas(set, tile.terrain);
    const piece = member ? canonicalTerrainMask(terrain.style, tile.terrain!.mask) : null;
    if (tile.id === tileId) {
      if (piece === want) return tile;
      changed = true;
      return { ...tile, terrain: pieceMembership(set, tile.terrain, storedPieceMask(terrain.style, want)) };
    }
    if (piece !== want) return tile;
    changed = true;
    return withoutTerrain(tile);
  });
  return changed ? { ...tileset, tiles } : tileset;
}

/** Take every tile drawing the piece `mask` out of the set. Returns `tileset` itself when none does. */
export function clearAutotilePiece(tileset: TilesetPayload, set: AutotilePieceSet, mask: number): TilesetPayload {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  if (!terrain) return tileset;
  const want = canonicalTerrainMask(terrain.style, mask);
  let changed = false;
  const tiles = tileset.tiles.map((tile) => {
    if (!autotilePieceSetHas(set, tile.terrain) || canonicalTerrainMask(terrain.style, tile.terrain!.mask) !== want) return tile;
    changed = true;
    return withoutTerrain(tile);
  });
  return changed ? { ...tileset, tiles } : tileset;
}

/** Take one tile out of the set. Returns `tileset` itself when the tile is not one of its pieces. */
export function removeTileFromAutotile(tileset: TilesetPayload, set: AutotilePieceSet, tileId: number): TilesetPayload {
  let changed = false;
  const tiles = tileset.tiles.map((tile) => {
    if (tile.id !== tileId || !autotilePieceSetHas(set, tile.terrain)) return tile;
    changed = true;
    return withoutTerrain(tile);
  });
  return changed ? { ...tileset, tiles } : tileset;
}

/**
 * A block of pieces laid out as the art usually draws it: one canonical mask
 * per cell, row-major from the block's top-left (row 0 is the top of the
 * sheet, which is north); `null` cells are left alone.
 */
export interface AutotileTemplate {
  id: string;
  title: string;
  columns: number;
  rows: number;
  masks: ReadonlyArray<number | null>;
}

const N = TERRAIN_N;
const E = TERRAIN_E;
const S = TERRAIN_S;
const W = TERRAIN_W;

const SIDES_ISLAND: readonly number[] = [E | S, E | S | W, S | W, N | E | S, N | E | S | W, N | S | W, N | E, N | E | W, N | W];
const HORIZONTAL_STRIP: readonly number[] = [E, E | W, W];
const VERTICAL_STRIP: readonly number[] = [S, N | S, N];

/** Shared sub-blocks; Blob reads each cell with its corners filled where both sides join. */
function subBlocks(style: TilesetTerrainStyle): AutotileTemplate[] {
  const read = (mask: number) => canonicalTerrainMask(style, withFilledCorners(mask));
  return [
    { id: "island", title: "Island (3 × 3)", columns: 3, rows: 3, masks: SIDES_ISLAND.map(read) },
    { id: "horizontal-strip", title: "Horizontal Strip (3 × 1)", columns: 3, rows: 1, masks: HORIZONTAL_STRIP.map(read) },
    { id: "vertical-strip", title: "Vertical Strip (1 × 3)", columns: 1, rows: 3, masks: VERTICAL_STRIP.map(read) },
    { id: "single", title: "Single (1 × 1)", columns: 1, rows: 1, masks: [0] },
  ];
}

/** Templates per style: the standard full block first, then the sub-blocks art often draws on its own. */
export const AUTOTILE_TEMPLATES: Readonly<Record<TilesetTerrainStyle, readonly AutotileTemplate[]>> = {
  sides: [
    { id: "sides-block", title: "4 Sides Block (4 × 4)", ...AUTOTILE_LAYOUTS.sides },
    ...subBlocks("sides"),
  ],
  blob: [
    { id: "blob-block", title: "Blob Block (12 × 4)", ...AUTOTILE_LAYOUTS.blob },
    ...subBlocks("blob"),
    {
      // Four notches meeting at the block's centre, around a one-tile hole.
      id: "inner-corners-hole",
      title: "Inner Corners, Hole (2 × 2)",
      columns: 2,
      rows: 2,
      masks: [TERRAIN_ALL & ~TERRAIN_SE, TERRAIN_ALL & ~TERRAIN_SW, TERRAIN_ALL & ~TERRAIN_NE, TERRAIN_ALL & ~TERRAIN_NW],
    },
    {
      // Each notch points away from the block's centre, at the corner it sits in.
      id: "inner-corners-outward",
      title: "Inner Corners, Outward (2 × 2)",
      columns: 2,
      rows: 2,
      masks: [TERRAIN_ALL & ~TERRAIN_NW, TERRAIN_ALL & ~TERRAIN_NE, TERRAIN_ALL & ~TERRAIN_SW, TERRAIN_ALL & ~TERRAIN_SE],
    },
  ],
};

/** Whether the template fits on the sheet at all. */
export function autotileTemplateFits(tileset: TilesetPayload, template: AutotileTemplate): boolean {
  return template.columns <= tilesetAtlasColumns(tileset) && template.rows <= tilesetAtlasRows(tileset);
}

/** The atlas tile `columns` right and `rows` down from `tileId`, or `null` off the sheet. */
export function offsetAtlasTile(tileset: TilesetPayload, tileId: number, columns: number, rows: number): number | null {
  const atlasColumns = tilesetAtlasColumns(tileset);
  const atlasRows = tilesetAtlasRows(tileset);
  if (tileId < 1) return null;
  const column = ((tileId - 1) % atlasColumns) + columns;
  const row = Math.floor((tileId - 1) / atlasColumns) + rows;
  if (column < 0 || row < 0 || column >= atlasColumns || row >= atlasRows) return null;
  return row * atlasColumns + column + 1;
}

/**
 * The atlas tile under each template cell with the template's top-left on
 * `anchorTileId`, or `null` when the block runs past the sheet.
 */
export function autotileTemplatePlacement(
  tileset: TilesetPayload,
  template: AutotileTemplate,
  anchorTileId: number,
): Array<{ tileId: number; mask: number | null }> | null {
  if (offsetAtlasTile(tileset, anchorTileId, template.columns - 1, template.rows - 1) === null) return null;
  return template.masks.map((mask, at) => ({
    tileId: offsetAtlasTile(tileset, anchorTileId, at % template.columns, Math.floor(at / template.columns))!,
    mask,
  }));
}

/**
 * Assign every placed template cell its piece, as `assignAutotilePiece` would
 * one by one. `pieces` counts the cells assigned; `replaced` counts existing
 * memberships (of this set or another autotile) the edit changes or removes.
 * `null` when the block runs past the sheet.
 */
export function applyAutotileTemplate(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  template: AutotileTemplate,
  anchorTileId: number,
): { next: TilesetPayload; pieces: number; replaced: number } | null {
  const placement = autotileTemplatePlacement(tileset, template, anchorTileId);
  if (!placement || !tilesetTerrainById(tileset, set.terrainId)) return null;
  let next = tileset;
  let pieces = 0;
  for (const cell of placement) {
    if (cell.mask === null) continue;
    pieces += 1;
    next = assignAutotilePiece(next, set, cell.mask, cell.tileId);
  }
  const after = new Map(next.tiles.map((tile) => [tile.id, tile]));
  let replaced = 0;
  for (const tile of tileset.tiles) {
    if (tile.terrain && after.get(tile.id)?.terrain !== tile.terrain) replaced += 1;
  }
  return { next, pieces, replaced };
}

/**
 * What switching the set's terrain to `style` does to its tiles, which keep
 * their masks: `kept` pieces still have a tile, `missing` pieces have none,
 * and `unusedTileIds` draw a piece another tile already draws, so painting
 * never picks them.
 */
export function autotileLayoutChange(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  style: TilesetTerrainStyle,
): { kept: number; missing: number; unusedTileIds: number[] } {
  const pieces = new Map<number, number[]>();
  const members = tileset.tiles.filter((tile) => autotilePieceSetHas(set, tile.terrain)).sort((a, b) => a.id - b.id);
  for (const tile of members) {
    const mask = canonicalTerrainMask(style, tile.terrain!.mask);
    pieces.set(mask, [...(pieces.get(mask) ?? []), tile.id]);
  }
  return {
    kept: pieces.size,
    missing: terrainVariantMasks(style).length - pieces.size,
    unusedTileIds: [...pieces.values()].flatMap((ids) => ids.slice(1)).sort((a, b) => a - b),
  };
}

/** Size of the Autotiles window's test-paint map, in tiles. */
export const AUTOTILE_SANDBOX_WIDTH = 14;
export const AUTOTILE_SANDBOX_HEIGHT = 9;

/**
 * Sample shapes for test paint, top row first: an island (with a one-tile
 * hole for Blob, which draws its inner corners), a vertical strip, a single
 * and a horizontal strip. 4 Sides draws every one of its 16 pieces.
 */
const SANDBOX_SAMPLE: Record<TilesetTerrainStyle, readonly string[]> = {
  sides: [
    "..............",
    ".#####........",
    ".#####..#.....",
    ".#####..#..#..",
    ".#####..#.....",
    ".#####..#.....",
    "..............",
    ".############.",
    "..............",
  ],
  blob: [
    "..............",
    ".#####........",
    ".#####..#.....",
    ".##.##..#..#..",
    ".#####..#.....",
    ".#####..#.....",
    "..............",
    ".############.",
    "..............",
  ],
};

/** The sample's painted cells in map coordinates (+Y up, row 0 at the bottom). */
export function autotileSandboxSample(style: TilesetTerrainStyle): Array<{ x: number; y: number }> {
  const rows = SANDBOX_SAMPLE[style];
  return rows.flatMap((row, top) =>
    [...row].flatMap((cell, x) => (cell === "#" ? [{ x, y: rows.length - 1 - top }] : [])),
  );
}

/** One painted test-paint cell: the tile painting picks, the piece it wanted, and whether the tile only stands in for it. */
export interface AutotileSandboxTile {
  tileId: number;
  want: number;
  standIn: boolean;
}

/** Map-local Tileset guid of the test-paint map. */
const SANDBOX_TILESET = "autotile-sandbox";
const SANDBOX_LAYER = "sandbox";

/**
 * Paint `cells` with the set's terrain on an in-memory map of `width` ×
 * `height` through `paintTilemapTerrain`, so every cell gets the tile the
 * Tilemap brush would paint there (one batch write equals any stroke order).
 * Keyed `x,y`; `tileId` is 0 when the terrain has no tiles. A tile stands in
 * when its piece differs from the one its neighbours want.
 */
export function autotileSandboxTiles(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  cells: Iterable<{ x: number; y: number }>,
  size: { width: number; height: number },
): Map<string, AutotileSandboxTile> {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  const painted = new Map<string, { x: number; y: number }>();
  for (const cell of cells) {
    if (cell.x >= 0 && cell.y >= 0 && cell.x < size.width && cell.y < size.height) painted.set(`${cell.x},${cell.y}`, cell);
  }
  const result = new Map<string, AutotileSandboxTile>();
  if (!terrain) return result;
  const blank: TilemapPayload = {
    tilesets: [{ guid: SANDBOX_TILESET, firstGid: 1, tileCount: tileset.tiles.reduce((most, tile) => Math.max(most, tile.id), 0) }],
    tileWidth: tileset.tileWidth,
    tileHeight: tileset.tileHeight,
    width: size.width,
    height: size.height,
    chunkSize: Math.max(size.width, size.height, 1),
    layers: [createTilemapLayer(SANDBOX_LAYER, "Test Paint")],
  };
  const map = paintTilemapTerrain(blank, {
    layerId: SANDBOX_LAYER,
    cells: painted.values(),
    terrain: { guid: SANDBOX_TILESET, terrainId: set.terrainId },
    tilesets: new Map([[SANDBOX_TILESET, tileset]]),
  });
  const masks = new Map(tileset.tiles.map((tile) => [tile.id, tile.terrain?.mask ?? 0]));
  for (const [key, cell] of painted) {
    let mask = 0;
    for (const { bit, dx, dy } of TERRAIN_NEIGHBOURS) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      // Cells past the map edge join, as on a Tilemap.
      const outside = x < 0 || y < 0 || x >= size.width || y >= size.height;
      if (outside || painted.has(`${x},${y}`)) mask |= bit;
    }
    const want = canonicalTerrainMask(terrain.style, mask);
    const tileId = getTile(map, SANDBOX_LAYER, cell.x, cell.y);
    const standIn = tileId > 0 && canonicalTerrainMask(terrain.style, masks.get(tileId) ?? 0) !== want;
    result.set(key, { tileId, want, standIn });
  }
  return result;
}
