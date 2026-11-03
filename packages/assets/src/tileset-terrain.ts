/**
 * Autotile terrain masks and variant resolution (Babylon-free). A mask holds
 * the neighbours a cell joins, clockwise from north in +Y-up tile space.
 */

import { fnv1a } from "@haptic/core";
import {
  tilesetAtlasColumns,
  tilesetAtlasRows,
  tilesetTerrainById,
  type TilesetPayload,
  type TilesetTerrainStyle,
  type TilesetTile,
  type TilesetTileTerrain,
} from "./tileset-payload";

export const TERRAIN_N = 1;
export const TERRAIN_NE = 2;
export const TERRAIN_E = 4;
export const TERRAIN_SE = 8;
export const TERRAIN_S = 16;
export const TERRAIN_SW = 32;
export const TERRAIN_W = 64;
export const TERRAIN_NW = 128;
export const TERRAIN_SIDES = TERRAIN_N | TERRAIN_E | TERRAIN_S | TERRAIN_W;
export const TERRAIN_ALL = 0xff;

/** Every neighbour bit with its cell offset (+Y up), clockwise from north. */
export const TERRAIN_NEIGHBOURS: ReadonlyArray<{ bit: number; dx: number; dy: number }> = [
  { bit: TERRAIN_N, dx: 0, dy: 1 },
  { bit: TERRAIN_NE, dx: 1, dy: 1 },
  { bit: TERRAIN_E, dx: 1, dy: 0 },
  { bit: TERRAIN_SE, dx: 1, dy: -1 },
  { bit: TERRAIN_S, dx: 0, dy: -1 },
  { bit: TERRAIN_SW, dx: -1, dy: -1 },
  { bit: TERRAIN_W, dx: -1, dy: 0 },
  { bit: TERRAIN_NW, dx: -1, dy: 1 },
];

/** Each corner bit with the two sides it needs. */
const CORNERS: ReadonlyArray<{ bit: number; sides: number }> = [
  { bit: TERRAIN_NE, sides: TERRAIN_N | TERRAIN_E },
  { bit: TERRAIN_SE, sides: TERRAIN_S | TERRAIN_E },
  { bit: TERRAIN_SW, sides: TERRAIN_S | TERRAIN_W },
  { bit: TERRAIN_NW, sides: TERRAIN_N | TERRAIN_W },
];

const SIDE_BITS = [TERRAIN_N, TERRAIN_E, TERRAIN_S, TERRAIN_W];

/**
 * The mask a style reads: `sides` keeps only N, E, S and W (16 variants);
 * `blob` keeps a corner only when both adjacent sides join (47 variants).
 */
export function canonicalTerrainMask(style: TilesetTerrainStyle, mask: number): number {
  const sides = mask & TERRAIN_SIDES;
  if (style === "sides") return sides;
  let canonical = sides;
  for (const corner of CORNERS) {
    if ((mask & corner.bit) && (sides & corner.sides) === corner.sides) canonical |= corner.bit;
  }
  return canonical;
}

/** Every distinct canonical mask of a style, ascending: 16 for `sides`, 47 for `blob`. */
export function terrainVariantMasks(style: TilesetTerrainStyle): number[] {
  const masks = new Set<number>();
  for (let mask = 0; mask <= TERRAIN_ALL; mask++) masks.add(canonicalTerrainMask(style, mask));
  return [...masks].sort((a, b) => a - b);
}

/**
 * How far a tile drawn for canonical mask `have` is from the wanted canonical
 * mask `want`, as a tuple compared in order (lower is closer):
 *
 * 1. sides the cell joins that the tile draws open (an edge inside the terrain);
 * 2. sides the tile joins that the cell leaves open (a cut-off edge);
 * 3. inner-corner notches the tile draws that the cell does not want;
 * 4. inner-corner notches the cell wants that the tile fills.
 *
 * A notch is a corner whose two sides join but whose diagonal does not. Corner
 * terms only count where the tile joins both adjacent sides; elsewhere the tile
 * draws an outer edge, which the side terms already price. `sides` terrains
 * never carry corners, so only the side terms apply.
 */
export function terrainMatchScore(want: number, have: number): [number, number, number, number] {
  let missingSides = 0;
  let extraSides = 0;
  for (const side of SIDE_BITS) {
    if ((want & side) && !(have & side)) missingSides += 1;
    else if (!(want & side) && (have & side)) extraSides += 1;
  }
  let unwantedNotches = 0;
  let missingNotches = 0;
  for (const corner of CORNERS) {
    if ((have & corner.sides) !== corner.sides) continue;
    const tileNotch = !(have & corner.bit);
    const wantNotch = (want & corner.sides) === corner.sides && !(want & corner.bit);
    if (tileNotch && !wantNotch) unwantedNotches += 1;
    else if (!tileNotch && wantNotch) missingNotches += 1;
  }
  return [missingSides, extraSides, unwantedNotches, missingNotches];
}

/** Picks the variants of one terrain (`createTerrainResolver`). */
export interface TerrainResolver {
  /**
   * The member tile for neighbour `mask`, from the set drawn against the
   * terrain `border` (omitted: the default set, drawn against nothing). The
   * candidates are that set's tiles; a set without tiles falls back to the
   * default set, and an empty default set to every tile of the terrain. Among
   * them wins the exact canonical mask, otherwise the closest by
   * `terrainMatchScore`, ties going to the lowest tile id.
   */
  resolve(mask: number, border?: string): number;
  /** Terrains this terrain has a border set with at least one tile for. */
  readonly borders: ReadonlySet<string>;
}

interface TerrainMemberTile {
  id: number;
  mask: number;
}

/** Tiles of the atlas grid; a member tile past it never draws, so terrain code ignores it. */
function atlasTileCount(tileset: TilesetPayload): number {
  return tilesetAtlasColumns(tileset) * tilesetAtlasRows(tileset);
}

/**
 * Variant picker for one terrain of `tileset`, or `null` when the terrain does
 * not exist or has no tiles. `maxTileId` limits members to the ids a map's
 * Tileset range can encode; tiles past the atlas never draw and never count,
 * so a payload resolves the same with or without `ensureTilesetTiles`.
 */
export function createTerrainResolver(
  tileset: TilesetPayload,
  terrainId: string,
  maxTileId = Number.POSITIVE_INFINITY,
): TerrainResolver | null {
  const terrain = tilesetTerrainById(tileset, terrainId);
  if (!terrain) return null;
  const declared = new Set(terrain.borders ?? []);
  const limit = Math.min(maxTileId, atlasTileCount(tileset));
  const all: TerrainMemberTile[] = [];
  // Sets by border id; the default set is "".
  const sets = new Map<string, TerrainMemberTile[]>();
  for (const tile of tileset.tiles) {
    const membership = tile.terrain;
    if (membership?.id !== terrainId || tile.id > limit) continue;
    const border = membership.border ?? "";
    if (border && !declared.has(border)) continue;
    const member = { id: tile.id, mask: canonicalTerrainMask(terrain.style, membership.mask) };
    all.push(member);
    const set = sets.get(border);
    if (set) set.push(member);
    else sets.set(border, [member]);
  }
  if (all.length === 0) return null;
  const byId = (a: TerrainMemberTile, b: TerrainMemberTile) => a.id - b.id;
  all.sort(byId);
  for (const set of sets.values()) set.sort(byId);
  const caches = new Map<readonly TerrainMemberTile[], Map<number, number>>();
  return {
    borders: new Set([...sets.keys()].filter((border) => border !== "")),
    resolve(mask, border) {
      const members = (border ? sets.get(border) : undefined) ?? sets.get("") ?? all;
      let cache = caches.get(members);
      if (!cache) caches.set(members, (cache = new Map()));
      const want = canonicalTerrainMask(terrain.style, mask);
      const cached = cache.get(want);
      if (cached !== undefined) return cached;
      let best = members[0]!;
      let bestScore = terrainMatchScore(want, best.mask);
      for (let at = 1; at < members.length; at++) {
        const member = members[at]!;
        const score = terrainMatchScore(want, member.mask);
        // Members are in id order, so only a strictly closer tile replaces the best.
        if (compareScores(score, bestScore) < 0) {
          best = member;
          bestScore = score;
        }
      }
      cache.set(want, best.id);
      return best.id;
    },
  };
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length; at++) {
    const delta = a[at]! - b[at]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

/** The 4 Sides island: a 3×3 block, a vertical strip, a horizontal strip and a lone tile. */
const SIDES_ISLAND: readonly number[] = [
  TERRAIN_E | TERRAIN_S, TERRAIN_E | TERRAIN_S | TERRAIN_W, TERRAIN_S | TERRAIN_W, TERRAIN_S,
  TERRAIN_N | TERRAIN_E | TERRAIN_S, TERRAIN_SIDES, TERRAIN_N | TERRAIN_S | TERRAIN_W, TERRAIN_N | TERRAIN_S,
  TERRAIN_N | TERRAIN_E, TERRAIN_N | TERRAIN_E | TERRAIN_W, TERRAIN_N | TERRAIN_W, TERRAIN_N,
  TERRAIN_E, TERRAIN_E | TERRAIN_W, TERRAIN_W, 0,
];

/** Every corner whose two sides `mask` joins: the island with solid inner corners. */
function withFilledCorners(mask: number): number {
  let filled = mask;
  for (const corner of CORNERS) if ((mask & corner.sides) === corner.sides) filled |= corner.bit;
  return filled;
}

/** A standard autotile sheet layout: one canonical mask per cell, row-major from the top-left; `null` cells are unused. */
export interface AutotileLayout {
  columns: number;
  rows: number;
  masks: ReadonlyArray<number | null>;
}

function blobLayout(): AutotileLayout {
  const island = SIDES_ISLAND.map(withFilledCorners);
  const notched = terrainVariantMasks("blob").filter((mask) => !island.includes(mask));
  // Columns 1–4 hold the island with solid corners; columns 5–12 the 31 inner-corner variants in ascending order.
  const masks: Array<number | null> = [];
  for (let row = 0; row < 4; row++) {
    masks.push(...island.slice(row * 4, row * 4 + 4));
    for (let column = 0; column < 8; column++) masks.push(notched[column * 4 + row] ?? null);
  }
  return { columns: 12, rows: 4, masks };
}

/** Standard layouts `Fill From Layout` writes: 4 Sides as a 4×4 block, Blob as a 12×4 block. */
export const AUTOTILE_LAYOUTS: Readonly<Record<TilesetTerrainStyle, AutotileLayout>> = {
  sides: { columns: 4, rows: 4, masks: SIDES_ISLAND },
  blob: blobLayout(),
};

/**
 * The atlas tile under each layout cell when the layout's top-left sits on
 * `startTileId`, or `null` when the block runs past the atlas.
 */
export function autotileLayoutPlacement(
  tileset: TilesetPayload,
  style: TilesetTerrainStyle,
  startTileId: number,
): Array<{ tileId: number; mask: number | null }> | null {
  const layout = AUTOTILE_LAYOUTS[style];
  const columns = tilesetAtlasColumns(tileset);
  const rows = tilesetAtlasRows(tileset);
  if (columns <= 0 || startTileId < 1) return null;
  const startColumn = (startTileId - 1) % columns;
  const startRow = Math.floor((startTileId - 1) / columns);
  if (startColumn + layout.columns > columns || startRow + layout.rows > rows) return null;
  return layout.masks.map((mask, at) => ({
    tileId: (startRow + Math.floor(at / layout.columns)) * columns + startColumn + (at % layout.columns) + 1,
    mask,
  }));
}

/** A terrain membership in the default set, or in the set drawn against `border`. */
function terrainMembership(terrainId: string, mask: number, border: string | undefined): TilesetTileTerrain {
  return border === undefined ? { id: terrainId, mask } : { id: terrainId, mask, border };
}

/** Whether `tile` is in the terrain's default set, or in its set drawn against `border`. */
function inTerrainSet(tile: Pick<TilesetTile, "terrain"> | undefined, terrainId: string, border: string | undefined): boolean {
  return tile?.terrain?.id === terrainId && tile.terrain.border === border;
}

/**
 * Give the layout's tiles their terrain and neighbours, in the default set or
 * the set drawn against `border`; unused cells and tiles outside the block are
 * left as they are, and a border the terrain does not declare changes nothing.
 */
export function applyAutotileLayout(
  tileset: TilesetPayload,
  terrainId: string,
  startTileId: number,
  border?: string,
): TilesetPayload {
  const terrain = tilesetTerrainById(tileset, terrainId);
  if (!terrain || (border !== undefined && !terrain.borders?.includes(border))) return tileset;
  const placement = autotileLayoutPlacement(tileset, terrain.style, startTileId);
  if (!placement) return tileset;
  const masks = new Map(placement.flatMap((cell) => (cell.mask === null ? [] : [[cell.tileId, cell.mask] as const])));
  return {
    ...tileset,
    tiles: tileset.tiles.map((tile) => {
      const mask = masks.get(tile.id);
      return mask === undefined ? tile : { ...tile, terrain: terrainMembership(terrainId, mask, border) };
    }),
  };
}

/** A zone of a tile in the atlas Autotile tool: `0` is the centre (membership), any other value one neighbour bit. */
export type AutotileZone = number;

/** Corners that stop counting once their side opens. */
const SIDE_CORNERS = new Map(SIDE_BITS.map((side) => [side, CORNERS.filter((corner) => corner.sides & side).reduce((bits, corner) => bits | corner.bit, 0)]));
const CORNER_SIDES = new Map(CORNERS.map((corner) => [corner.bit, corner.sides]));

/**
 * Whether a tile's zone is on for a terrain's set (the default set, or the one
 * drawn against `border`): the centre when the tile is in that set, a side or
 * corner when its mask joins there.
 */
export function autotileZoneOn(
  tile: Pick<TilesetTile, "terrain"> | undefined,
  terrainId: string,
  zone: AutotileZone,
  border?: string,
): boolean {
  if (!inTerrainSet(tile, terrainId, border)) return false;
  return zone === 0 || (tile!.terrain!.mask & zone) !== 0;
}

/**
 * Turn one zone of a tile on or off for a terrain's set (the default set, or
 * the one drawn against `border`). Turning on any zone puts the tile in that
 * set (a tile of another terrain or set moves over with no neighbours); a
 * corner turns its two sides on with it, and a side turned off takes its
 * corners along. Turning the centre off removes the tile from the terrain.
 */
export function setAutotileZone(
  tile: TilesetTile,
  terrainId: string,
  zone: AutotileZone,
  on: boolean,
  border?: string,
): TilesetTile {
  const member = inTerrainSet(tile, terrainId, border);
  if (!on) {
    if (!member) return tile;
    if (zone === 0) {
      const next = { ...tile };
      delete next.terrain;
      return next;
    }
    const mask = tile.terrain!.mask & ~zone & ~(SIDE_CORNERS.get(zone) ?? 0);
    return mask === tile.terrain!.mask ? tile : { ...tile, terrain: terrainMembership(terrainId, mask, border) };
  }
  const base = member ? tile.terrain!.mask : 0;
  const mask = zone === 0 ? base : base | zone | (CORNER_SIDES.get(zone) ?? 0);
  return member && mask === base ? tile : { ...tile, terrain: terrainMembership(terrainId, mask, border) };
}

/**
 * Canonical masks of a terrain's style that no tile of one of its sets draws
 * exactly, ascending: the default set, or the set drawn against `border`.
 * Tiles past the atlas draw nothing. Empty for a terrain the Tileset lacks or
 * a border the terrain does not declare.
 */
export function missingTerrainVariants(tileset: TilesetPayload, terrainId: string, border?: string): number[] {
  const terrain = tilesetTerrainById(tileset, terrainId);
  if (!terrain || (border !== undefined && !terrain.borders?.includes(border))) return [];
  const limit = atlasTileCount(tileset);
  const drawn = new Set(
    tileset.tiles.flatMap((tile) =>
      inTerrainSet(tile, terrainId, border) && tile.id <= limit ? [canonicalTerrainMask(terrain.style, tile.terrain!.mask)] : []),
  );
  return terrainVariantMasks(terrain.style).filter((mask) => !drawn.has(mask));
}

/** `tilesetTerrainStamp` of a Tileset without terrains. */
const NO_TERRAIN_STAMP = "0";
/** Payloads are replaced on edit, never changed in place, so one stamp per object holds. */
const terrainStamps = new WeakMap<TilesetPayload, string>();

/**
 * A short deterministic hash (FNV-1a hex) of everything terrain resolution
 * reads from a Tileset: each terrain's id, style and borders, and the
 * membership (terrain, mask, border) of each tile inside the atlas. Names,
 * list order and other tile data do not count, and a payload stamps the same
 * with or without `ensureTilesetTiles`. A Tileset without terrains stamps "0".
 */
export function tilesetTerrainStamp(tileset: TilesetPayload): string {
  const cached = terrainStamps.get(tileset);
  if (cached !== undefined) return cached;
  const terrains = tileset.terrains ?? [];
  let stamp = NO_TERRAIN_STAMP;
  if (terrains.length > 0) {
    const ids = new Set(terrains.map((terrain) => terrain.id));
    const limit = atlasTileCount(tileset);
    const data = [
      terrains
        .map((terrain) => [terrain.id, terrain.style, [...(terrain.borders ?? [])].sort()] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      tileset.tiles
        .flatMap((tile) => (tile.terrain && tile.id <= limit && ids.has(tile.terrain.id)
          ? [[tile.id, tile.terrain.id, tile.terrain.mask, tile.terrain.border ?? ""] as const]
          : []))
        .sort((a, b) => a[0] - b[0]),
    ];
    stamp = fnv1a(JSON.stringify(data));
  }
  terrainStamps.set(tileset, stamp);
  return stamp;
}

/** The variant a terrain paints with every neighbour joined: its fill tile, shown as its swatch. */
export function terrainFillMask(style: TilesetTerrainStyle): number {
  return style === "sides" ? TERRAIN_SIDES : TERRAIN_ALL;
}
