/**
 * Autotile terrain masks and variant resolution (Babylon-free). A mask holds
 * the neighbours a cell joins, clockwise from north in +Y-up tile space.
 */

import {
  tilesetTerrainById,
  type TilesetPayload,
  type TilesetTerrainStyle,
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

/**
 * Variant picker for one terrain of `tileset`, or `null` when the terrain does
 * not exist or has no tiles. The picker maps a neighbour mask to the member
 * tile with the exact canonical mask, otherwise the closest by
 * `terrainMatchScore`, ties going to the lowest tile id. `maxTileId` limits
 * members to the ids a map's Tileset range can encode.
 */
export function createTerrainResolver(
  tileset: TilesetPayload,
  terrainId: string,
  maxTileId = Number.POSITIVE_INFINITY,
): ((mask: number) => number) | null {
  const terrain = tilesetTerrainById(tileset, terrainId);
  if (!terrain) return null;
  const members: Array<{ id: number; mask: number }> = [];
  for (const tile of tileset.tiles) {
    if (tile.terrain?.id !== terrainId || tile.id > maxTileId) continue;
    members.push({ id: tile.id, mask: canonicalTerrainMask(terrain.style, tile.terrain.mask) });
  }
  if (members.length === 0) return null;
  members.sort((a, b) => a.id - b.id);
  const cache = new Map<number, number>();
  return (mask) => {
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
  };
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length; at++) {
    const delta = a[at]! - b[at]!;
    if (delta !== 0) return delta;
  }
  return 0;
}
