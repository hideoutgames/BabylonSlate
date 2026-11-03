/** Terrain (autotile) painting on Tilemap layers; pure and Babylon-free. */

import { tilesetTerrainById, tilesetTileById, type TilesetPayload, type TilesetTerrainStyle } from "./tileset-payload";
import { createTerrainResolver, TERRAIN_NEIGHBOURS, TERRAIN_SIDES, type TerrainResolver } from "./tileset-terrain";
import {
  chunkCoordForTile,
  encodeTileGid,
  localIndex,
  setTiles,
  tileInBounds,
  tilemapTileIdentity,
  type TilemapChunkIndex,
  type TilemapLayer,
  type TilemapPayload,
  type TileWrite,
} from "./tilemap-payload";

/** A terrain of one of the map's Tilesets. */
export interface TilemapTerrainBrush {
  guid: string;
  terrainId: string;
}

/** One terrain of one of the map's Tilesets, with its resolver; one object per terrain, so identity compares terrains. */
interface TerrainMember {
  key: string;
  guid: string;
  terrainId: string;
  style: TilesetTerrainStyle;
  firstGid: number;
  resolver: TerrainResolver;
}

/** Identity of a terrain across a map: its Tileset and its id within it. */
export function tilemapTerrainKey(brush: TilemapTerrainBrush): string {
  return `${brush.guid}\u0000${brush.terrainId}`;
}

/**
 * Terrain lookups for one map and its loaded Tilesets: which terrain a GID
 * belongs to, and the resolver that picks a terrain's variant.
 */
function terrainMembers(map: TilemapPayload, tilesets: ReadonlyMap<string, TilesetPayload>) {
  const bySet = new Map<string, TerrainMember | null>();
  const byGid = new Map<number, TerrainMember | null>();
  const ofSet = (brush: TilemapTerrainBrush): TerrainMember | null => {
    const key = tilemapTerrainKey(brush);
    let member = bySet.get(key);
    if (member !== undefined) return member;
    member = null;
    const ref = map.tilesets.find((entry) => entry.guid === brush.guid);
    const tileset = tilesets.get(brush.guid);
    const terrain = tileset ? tilesetTerrainById(tileset, brush.terrainId) : null;
    const resolver = ref && tileset ? createTerrainResolver(tileset, brush.terrainId, ref.tileCount) : null;
    if (ref && terrain && resolver) {
      member = { key, guid: brush.guid, terrainId: brush.terrainId, style: terrain.style, firstGid: ref.firstGid, resolver };
    }
    bySet.set(key, member);
    return member;
  };
  const ofGid = (gid: number): TerrainMember | null => {
    let member = byGid.get(gid);
    if (member !== undefined) return member;
    member = null;
    const identity = tilemapTileIdentity(map, gid);
    const tileset = identity ? tilesets.get(identity.guid) : undefined;
    const terrain = identity && tileset ? tilesetTileById(tileset, identity.localId)?.terrain : undefined;
    if (identity && terrain) member = ofSet({ guid: identity.guid, terrainId: terrain.id });
    byGid.set(gid, member);
    return member;
  };
  return { ofSet, ofGid };
}

/** The terrain key of each GID (`tilemapTerrainKey`), or `null` outside every terrain. */
export function tilemapTerrainKeyOf(
  map: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): (gid: number) => string | null {
  const members = terrainMembers(map, tilesets);
  return (gid) => members.ofGid(gid)?.key ?? null;
}

/** One layer's GIDs by cell, reading each chunk through `index` when it has one. */
function layerReader(
  map: TilemapPayload,
  layer: TilemapLayer,
  index?: TilemapChunkIndex,
): (x: number, y: number) => number {
  const size = Math.max(1, map.chunkSize);
  const positions = index?.positionsOf(layer.chunks);
  let chunkTiles: (key: string) => readonly number[] | undefined;
  if (positions) {
    chunkTiles = (key) => {
      const at = positions.get(key);
      return at === undefined ? undefined : layer.chunks[at]!.tiles;
    };
  } else {
    const chunks = new Map<string, readonly number[]>();
    for (const chunk of layer.chunks) {
      const key = `${chunk.cx},${chunk.cy}`;
      if (!chunks.has(key)) chunks.set(key, chunk.tiles);
    }
    chunkTiles = (key) => chunks.get(key);
  }
  return (x, y) => {
    const { cx, cy, lx, ly } = chunkCoordForTile(x, y, size);
    return chunkTiles(`${cx},${cy}`)?.[localIndex(lx, ly, size)] ?? 0;
  };
}

/** `TERRAIN_NEIGHBOURS` indices of the sides (N, E, S, W) and of the corners. */
const SIDE_NEIGHBOURS = [0, 2, 4, 6] as const;
const CORNER_NEIGHBOURS = [1, 3, 5, 7] as const;

/** The terrain faced most often in `directions`, or `undefined` on a tie or when none is faced. */
function mostFacedBorder(faced: ReadonlyArray<string | null>, directions: readonly number[]): string | undefined {
  const counts = new Map<string, number>();
  for (const at of directions) {
    const border = faced[at];
    if (border) counts.set(border, (counts.get(border) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  let tied = false;
  for (const [border, count] of counts) {
    if (count > bestCount) {
      best = border;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/**
 * The GID a cell of `member` at (x, y) takes from its 8 neighbours' terrains
 * (`memberAt`; never their variants, so a painted cell changes only itself and
 * its 8 neighbours). Per direction: outside the map or the same terrain joins;
 * another terrain U of the same Tileset is open facing U when this terrain has
 * a border set for U, else joins when U has a border set for this terrain (U's
 * pieces draw the seam), else is open facing nothing; anything else is open
 * facing nothing. The set is the border faced most often on open sides, or on
 * open corners when every side joins (Blob only); a tie or no border picks the
 * default set.
 */
function resolveTerrainCell(
  map: TilemapPayload,
  member: TerrainMember,
  x: number,
  y: number,
  memberAt: (x: number, y: number) => TerrainMember | null,
): number {
  let mask = 0;
  const faced: Array<string | null> = [];
  for (const { bit, dx, dy } of TERRAIN_NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    let face: string | null = null;
    if (!tileInBounds(map, nx, ny)) {
      mask |= bit;
    } else {
      const other = memberAt(nx, ny);
      if (other === member) mask |= bit;
      else if (other && other.guid === member.guid) {
        if (member.resolver.borders.has(other.terrainId)) face = other.terrainId;
        else if (other.resolver.borders.has(member.terrainId)) mask |= bit;
      }
    }
    faced.push(face);
  }
  const border = (mask & TERRAIN_SIDES) !== TERRAIN_SIDES
    ? mostFacedBorder(faced, SIDE_NEIGHBOURS)
    : member.style === "blob" ? mostFacedBorder(faced, CORNER_NEIGHBOURS) : undefined;
  return encodeTileGid(member.firstGid, member.resolver.resolve(mask, border));
}

/**
 * Paint `cells` with a terrain, or erase them when `terrain` is `null`, then
 * pick the variant of every painted cell and of every terrain tile around them
 * from its 8 neighbours (`resolveTerrainCell`), read across chunk borders and
 * empty chunks. Cells outside the map always join, so terrain runs on past the
 * map edge, and are never written. Returns `map` itself when nothing changes,
 * and nothing changes when the terrain has no tiles.
 */
export function paintTilemapTerrain(
  map: TilemapPayload,
  options: {
    layerId: string;
    cells: Iterable<{ x: number; y: number }>;
    terrain: TilemapTerrainBrush | null;
    tilesets: ReadonlyMap<string, TilesetPayload>;
    index?: TilemapChunkIndex;
  },
): TilemapPayload {
  const layer = map.layers.find((entry) => entry.id === options.layerId);
  if (!layer) return map;
  const members = terrainMembers(map, options.tilesets);
  const brush = options.terrain ? members.ofSet(options.terrain) : null;
  if (options.terrain && !brush) return map;
  const targets = new Map<string, { x: number; y: number }>();
  for (const cell of options.cells) {
    if (tileInBounds(map, cell.x, cell.y)) targets.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
  }
  if (targets.size === 0) return map;
  const gidAt = layerReader(map, layer, options.index);
  const memberAt = (x: number, y: number): TerrainMember | null => {
    const key = `${x},${y}`;
    return targets.has(key) ? brush : members.ofGid(gidAt(x, y));
  };

  // Painted cells take the brush terrain; terrain tiles around any written cell
  // keep their own terrain and only change variant.
  const resolve = new Map<string, { x: number; y: number; member: TerrainMember }>();
  for (const [key, cell] of targets) {
    if (brush) resolve.set(key, { ...cell, member: brush });
    for (const { dx, dy } of TERRAIN_NEIGHBOURS) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      const neighbourKey = `${x},${y}`;
      if (targets.has(neighbourKey) || resolve.has(neighbourKey) || !tileInBounds(map, x, y)) continue;
      const member = members.ofGid(gidAt(x, y));
      if (member) resolve.set(neighbourKey, { x, y, member });
    }
  }

  const writes: TileWrite[] = [];
  if (!brush) for (const cell of targets.values()) writes.push({ ...cell, id: 0 });
  for (const entry of resolve.values()) {
    writes.push({ x: entry.x, y: entry.y, id: resolveTerrainCell(map, entry.member, entry.x, entry.y, memberAt) });
  }
  return setTiles(map, options.layerId, writes, options.index);
}

/**
 * Pick the variant of every terrain tile on every layer again from its 8
 * neighbours, as painting would: after a Tileset's terrains change. Tiles of
 * terrains that no longer exist, or have no tiles, stay as they are. Returns
 * `map` itself when no tile changes.
 */
export function refreshTilemapTerrains(
  map: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  const members = terrainMembers(map, tilesets);
  const size = Math.max(1, map.chunkSize);
  let next = map;
  for (const layer of map.layers) {
    const gidAt = layerReader(map, layer);
    const memberAt = (x: number, y: number) => members.ofGid(gidAt(x, y));
    const writes: TileWrite[] = [];
    for (const chunk of layer.chunks) {
      chunk.tiles.forEach((gid, at) => {
        const member = gid ? members.ofGid(gid) : null;
        if (!member) return;
        const x = chunk.cx * size + (at % size);
        const y = chunk.cy * size + Math.floor(at / size);
        const id = resolveTerrainCell(map, member, x, y, memberAt);
        if (id !== gid) writes.push({ x, y, id });
      });
    }
    if (writes.length > 0) next = setTiles(next, layer.id, writes);
  }
  return next;
}
