/**
 * Autotile authoring helpers for the Tileset Autotiles window (Babylon-free):
 * piece sets (default and border sets), one-tile-per-piece assignment, the
 * window's piece groups and the sheet blocks they assign from, Layout change
 * summaries and the preview map.
 */

import {
  AUTOTILE_LAYOUTS,
  canonicalTerrainMask,
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SIDES,
  TERRAIN_SW,
  TERRAIN_W,
  terrainVariantMasks,
  type AutotileLayout,
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
import { paintTilemapTerrain, tilemapTerrainCellPieces } from "./tilemap-terrain";

/**
 * The pieces one autotile draws: a terrain's default set, or (with `border`)
 * its border set, drawn where it meets that other terrain. A tile belongs to a
 * set when its membership has the set's terrain and border.
 */
export interface AutotilePieceSet {
  terrainId: string;
  border?: string;
}

/** Whether a tile membership is one of the set's pieces. */
export function autotilePieceSetHas(set: AutotilePieceSet, terrain: TilesetTileTerrain | undefined): boolean {
  return terrain?.id === set.terrainId && terrain.border === set.border;
}

/** Whether the Tileset can hold the set: its terrain exists and declares its border. */
function pieceSetExists(tileset: TilesetPayload, set: AutotilePieceSet): boolean {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  return terrain !== null && (set.border === undefined || (terrain.borders ?? []).includes(set.border));
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
  const next: TilesetTileTerrain = { ...current, id: set.terrainId, mask };
  if (set.border === undefined) delete next.border;
  else next.border = set.border;
  return next;
}

function withoutTerrain(tile: TilesetTile): TilesetTile {
  const next = { ...tile };
  delete next.terrain;
  return next;
}

/** Tiles of the atlas grid; a tile past it never draws. */
function atlasTileCount(tileset: TilesetPayload): number {
  return tilesetAtlasColumns(tileset) * tilesetAtlasRows(tileset);
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

/**
 * Make `tileId` the set's tile for the piece `mask` (any mask; its canonical
 * form for the set's style counts). One tile per piece: every other tile of
 * the set drawing that piece leaves the autotile, and a tile of another set or
 * autotile moves over. Returns `tileset` itself when nothing changes, or when
 * the terrain does not exist or does not declare the set's border.
 */
export function assignAutotilePiece(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  mask: number,
  tileId: number,
): TilesetPayload {
  const terrain = tilesetTerrainById(tileset, set.terrainId);
  if (!terrain || !pieceSetExists(tileset, set) || !tileset.tiles.some((tile) => tile.id === tileId)) return tileset;
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

/**
 * Pieces laid out as a sheet draws them: one canonical mask per cell,
 * row-major from the block's top-left (row 0 is the top of the sheet, which is
 * north); `null` cells are left alone.
 */
export interface AutotileBlock {
  columns: number;
  rows: number;
  masks: ReadonlyArray<number | null>;
}

/** One group of pieces on the Autotiles window's board. */
export interface AutotilePieceGroup {
  id: "pieces" | "main" | "inner-corners" | "more-corners";
  title: string;
  /** Columns of the group's board; an optional group wraps to the board's width instead. */
  columns: number;
  /** The group's pieces in board order. */
  masks: readonly number[];
  /** Starts collapsed and does not count toward a ready autotile. */
  optional: boolean;
  /** The block the group assigns from the sheet, from the tile tapped as its top-left. */
  block: AutotileBlock;
}

/** `count` columns of a standard layout, from column `from`. */
function layoutColumns(layout: AutotileLayout, from: number, count: number): AutotileBlock {
  const masks: Array<number | null> = [];
  for (let row = 0; row < layout.rows; row++) {
    for (let column = from; column < from + count; column++) masks.push(layout.masks[row * layout.columns + column] ?? null);
  }
  return { columns: count, rows: layout.rows, masks };
}

function blockPieces(block: AutotileBlock): number[] {
  return block.masks.filter((mask): mask is number => mask !== null);
}

/** The Blob island with filled corners: the standard Blob block's first four columns. */
const BLOB_MAIN = layoutColumns(AUTOTILE_LAYOUTS.blob, 0, 4);
/** The standard Blob block's other eight columns: the 31 notched pieces in ascending mask order. */
const BLOB_NOTCHED = layoutColumns(AUTOTILE_LAYOUTS.blob, 4, 8);
/** Four inner corners around a one-tile hole, each notch toward the block's centre. */
const BLOB_INNER_CORNERS: AutotileBlock = {
  columns: 2,
  rows: 2,
  masks: [TERRAIN_ALL & ~TERRAIN_SE, TERRAIN_ALL & ~TERRAIN_SW, TERRAIN_ALL & ~TERRAIN_NE, TERRAIN_ALL & ~TERRAIN_NW],
};
const BLOB_MORE_CORNERS = terrainVariantMasks("blob").filter(
  (mask) => !blockPieces(BLOB_MAIN).includes(mask) && !blockPieces(BLOB_INNER_CORNERS).includes(mask),
);

/**
 * The board's groups per style. 4 Sides has one: its standard 4 × 4 block.
 * Blob has Main (the island with filled corners, the standard block's first
 * four columns), Inner Corners (the hole arrangement) and the optional More
 * Corners (the other 27), whose block is the standard block's other eight
 * columns, so a standard 12 × 4 sheet is Main then More Corners.
 */
export const AUTOTILE_PIECE_GROUPS: Readonly<Record<TilesetTerrainStyle, readonly AutotilePieceGroup[]>> = {
  sides: [
    {
      id: "pieces",
      title: "Pieces",
      columns: AUTOTILE_LAYOUTS.sides.columns,
      masks: blockPieces(AUTOTILE_LAYOUTS.sides),
      optional: false,
      block: AUTOTILE_LAYOUTS.sides,
    },
  ],
  blob: [
    { id: "main", title: "Main", columns: BLOB_MAIN.columns, masks: blockPieces(BLOB_MAIN), optional: false, block: BLOB_MAIN },
    {
      id: "inner-corners",
      title: "Inner Corners",
      columns: BLOB_INNER_CORNERS.columns,
      masks: blockPieces(BLOB_INNER_CORNERS),
      optional: false,
      block: BLOB_INNER_CORNERS,
    },
    { id: "more-corners", title: "More Corners", columns: 9, masks: BLOB_MORE_CORNERS, optional: true, block: BLOB_NOTCHED },
  ],
};

/**
 * Whether the terrain's default set has a tile for every piece of its
 * style's required (not optional) groups: every 4 Sides piece, or Blob's Main
 * and Inner Corners. Tiles past the atlas do not count.
 */
export function autotileReady(tileset: TilesetPayload, terrainId: string): boolean {
  const terrain = tilesetTerrainById(tileset, terrainId);
  if (!terrain) return false;
  const limit = atlasTileCount(tileset);
  const drawn = new Set(
    tileset.tiles.flatMap((tile) =>
      tile.id <= limit && autotilePieceSetHas({ terrainId }, tile.terrain) ? [canonicalTerrainMask(terrain.style, tile.terrain!.mask)] : []),
  );
  return AUTOTILE_PIECE_GROUPS[terrain.style].every((group) => group.optional || group.masks.every((mask) => drawn.has(mask)));
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
 * The sheet tile under each cell of `block` with its top-left on
 * `anchorTileId`, row by row; cells past the sheet's right or bottom edge are
 * left out, so a block near the edge places only the part that fits. Empty
 * when the anchor is off the sheet.
 */
export function autotileBlockPlacement(
  tileset: TilesetPayload,
  block: AutotileBlock,
  anchorTileId: number,
): Array<{ tileId: number; mask: number | null }> {
  if (offsetAtlasTile(tileset, anchorTileId, 0, 0) === null) return [];
  return block.masks.flatMap((mask, at) => {
    const tileId = offsetAtlasTile(tileset, anchorTileId, at % block.columns, Math.floor(at / block.columns));
    return tileId === null ? [] : [{ tileId, mask }];
  });
}

/**
 * Assign every placed piece of the block (`autotileBlockPlacement`) as
 * `assignAutotilePiece` would one by one. Returns `tileset` itself when
 * nothing changes.
 */
export function applyAutotileBlock(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  block: AutotileBlock,
  anchorTileId: number,
): TilesetPayload {
  let next = tileset;
  for (const cell of autotileBlockPlacement(tileset, block, anchorTileId)) {
    if (cell.mask !== null) next = assignAutotilePiece(next, set, cell.mask, cell.tileId);
  }
  return next;
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

/** Size of the Autotiles window's preview map, in tiles. */
export const AUTOTILE_PREVIEW_WIDTH = 12;
export const AUTOTILE_PREVIEW_HEIGHT = 7;

/** A preview cell painted with an autotile, in map coordinates (+Y up, row 0 at the bottom). */
export interface AutotilePreviewCell {
  x: number;
  y: number;
  terrainId: string;
}

/**
 * Starting shapes per style, top row first (`#` is the autotile): for Blob an
 * island with a hole, a ragged bottom edge, a vertical strip, a horizontal
 * strip and a single; for 4 Sides horizontal strips of several lengths.
 */
const PREVIEW_SAMPLE: Record<TilesetTerrainStyle, readonly string[]> = {
  blob: [
    "............",
    ".#######....",
    ".##.####..#.",
    ".#######..#.",
    "..####....#.",
    "............",
    ".#####...#..",
  ],
  sides: [
    "............",
    "..######....",
    "............",
    ".......####.",
    "............",
    "...##....#..",
    "............",
  ],
};

/** A border set's starting shape: the autotile (`#`) inside a field of its border autotile (`D`). */
const PREVIEW_BORDER_SAMPLE: readonly string[] = [
  "DDDDDDDDDDDD",
  "DD#####DDDDD",
  "D#######DDDD",
  "D########DDD",
  "DD######DDDD",
  "DDD###DDDDDD",
  "DDDDDDDDDDDD",
];

/**
 * The starting preview map for a set: for the default set, shapes that use
 * most of the style's pieces; for a border set, the autotile inside a field of
 * its border autotile.
 */
export function autotilePreviewSample(style: TilesetTerrainStyle, set: AutotilePieceSet): AutotilePreviewCell[] {
  const rows = set.border === undefined ? PREVIEW_SAMPLE[style] : PREVIEW_BORDER_SAMPLE;
  return rows.flatMap((row, top) =>
    [...row].flatMap((cell, x) => {
      const terrainId = cell === "#" ? set.terrainId : cell === "D" ? set.border : undefined;
      return terrainId === undefined ? [] : [{ x, y: rows.length - 1 - top, terrainId }];
    }),
  );
}

/**
 * One painted preview cell: its autotile, the tile painting picks (0 when that
 * autotile has no tiles), the piece and set it wants (`want` is `null` when
 * the Tileset has no such autotile), and whether it shows something other than
 * that exact piece of that set.
 */
export interface AutotilePreviewTile {
  terrainId: string;
  tileId: number;
  want: number | null;
  border?: string;
  standIn: boolean;
}

/** Map-local Tileset guid of the preview map. */
const PREVIEW_TILESET = "autotile-preview";
const PREVIEW_LAYER = "preview";
/**
 * Paint `cells` through `paintTilemapTerrain`, one batch per autotile (each
 * batch re-resolves its neighbours, so any order gives the same map), on a map
 * of exactly `size`: as on a Tilemap, terrain at the preview's edge joins past it.
 */
function paintPreview(
  tileset: TilesetPayload,
  cells: readonly AutotilePreviewCell[],
  size: { width: number; height: number },
): { map: TilemapPayload; tilesets: Map<string, TilesetPayload> } {
  const byTerrain = new Map<string, Array<{ x: number; y: number }>>();
  for (const cell of cells) {
    const at = { x: cell.x, y: cell.y };
    const group = byTerrain.get(cell.terrainId);
    if (group) group.push(at);
    else byTerrain.set(cell.terrainId, [at]);
  }
  const tilesets = new Map([[PREVIEW_TILESET, tileset]]);
  const { width, height } = size;
  let map: TilemapPayload = {
    tilesets: [{ guid: PREVIEW_TILESET, firstGid: 1, tileCount: tileset.tiles.reduce((most, tile) => Math.max(most, tile.id), 0) }],
    tileWidth: tileset.tileWidth,
    tileHeight: tileset.tileHeight,
    width,
    height,
    chunkSize: Math.max(width, height),
    layers: [createTilemapLayer(PREVIEW_LAYER, "Preview")],
  };
  for (const [terrainId, group] of byTerrain) {
    map = paintTilemapTerrain(map, { layerId: PREVIEW_LAYER, cells: group, terrain: { guid: PREVIEW_TILESET, terrainId }, tilesets });
  }
  return { map, tilesets };
}

/**
 * `tileset` with a stand-in tile, in rows added below the atlas, for each
 * autotile with no tiles and for `set` when it has none, so the preview can
 * say which piece every cell wants before its set has art: an empty autotile
 * would otherwise paint nothing, and an empty border set would leave its cells
 * on the default set. `tileset` itself when none is needed.
 */
function previewWantTileset(tileset: TilesetPayload, set: AutotilePieceSet): TilesetPayload {
  const atlas = atlasTileCount(tileset);
  const stride = tileset.tileHeight + tileset.spacing;
  if (stride <= 0) return tileset;
  const tiles = tileset.tiles.filter((tile) => tile.id <= atlas);
  const probes: TilesetTileTerrain[] = [];
  for (const terrain of tileset.terrains ?? []) {
    const declared = new Set(terrain.borders ?? []);
    const hasTile = tiles.some((tile) =>
      tile.terrain?.id === terrain.id && (tile.terrain.border === undefined || declared.has(tile.terrain.border)));
    if (!hasTile) probes.push({ id: terrain.id, mask: TERRAIN_ALL });
  }
  if (set.border !== undefined && pieceSetExists(tileset, set) && !tiles.some((tile) => autotilePieceSetHas(set, tile.terrain))) {
    probes.push({ id: set.terrainId, mask: TERRAIN_ALL, border: set.border });
  }
  if (probes.length === 0) return tileset;
  const rows = Math.ceil(probes.length / tilesetAtlasColumns(tileset));
  return {
    ...tileset,
    atlasHeight: tileset.atlasHeight + rows * stride,
    tiles: [
      ...tiles,
      ...probes.map((terrain, at): TilesetTile => ({ id: atlas + at + 1, collision: "none", flags: 0, animation: [], terrain })),
    ],
  };
}

/**
 * Paint the preview map of `size` exactly as a Tilemap brush paints it
 * (`paintTilemapTerrain`, transitions included) and report each painted cell,
 * keyed `x,y`; cells past the preview are ignored, and the cells around it
 * count as empty, so shapes at its edge draw their edges. A cell's tile comes from the
 * Tileset as it is. The piece it wants (`tilemapTerrainCellPieces`) is read as
 * if every autotile had a tile and `set` had at least one, so cells show where
 * a piece goes before it has art; a cell stands in when its tile is not that
 * piece of that set, or it has no tile.
 */
export function autotilePreviewTiles(
  tileset: TilesetPayload,
  set: AutotilePieceSet,
  cells: Iterable<AutotilePreviewCell>,
  size: { width: number; height: number },
): Map<string, AutotilePreviewTile> {
  const painted = new Map<string, AutotilePreviewCell>();
  for (const cell of cells) {
    if (cell.x >= 0 && cell.y >= 0 && cell.x < size.width && cell.y < size.height) painted.set(`${cell.x},${cell.y}`, cell);
  }
  const list = [...painted.values()];
  const drawn = paintPreview(tileset, list, size);
  const wantTileset = previewWantTileset(tileset, set);
  const wanted = wantTileset === tileset ? drawn : paintPreview(wantTileset, list, size);
  const pieceAt = tilemapTerrainCellPieces(wanted.map, PREVIEW_LAYER, wanted.tilesets);
  const tiles = new Map(tileset.tiles.map((tile) => [tile.id, tile]));
  const result = new Map<string, AutotilePreviewTile>();
  for (const [key, cell] of painted) {
    const tileId = getTile(drawn.map, PREVIEW_LAYER, cell.x, cell.y);
    const piece = pieceAt(cell.x, cell.y);
    const terrain = piece ? tilesetTerrainById(tileset, piece.terrainId) : null;
    const membership = tiles.get(tileId)?.terrain;
    const exact = Boolean(
      piece && terrain && membership
        && autotilePieceSetHas({ terrainId: piece.terrainId, border: piece.border }, membership)
        && canonicalTerrainMask(terrain.style, membership.mask) === piece.mask,
    );
    const entry: AutotilePreviewTile = { terrainId: cell.terrainId, tileId, want: piece?.mask ?? null, standIn: piece !== null && !exact };
    if (piece?.border !== undefined) entry.border = piece.border;
    result.set(key, entry);
  }
  return result;
}
