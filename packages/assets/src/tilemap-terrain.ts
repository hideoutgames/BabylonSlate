/** Terrain (autotile) painting on Tilemap layers; pure and Babylon-free. */

import { tilesetTileById, type TilesetPayload } from "./tileset-payload";
import { createTerrainResolver, TERRAIN_NEIGHBOURS } from "./tileset-terrain";
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

interface TerrainMember {
  key: string;
  firstGid: number;
  resolve: (mask: number) => number;
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
    const resolve = ref && tileset ? createTerrainResolver(tileset, brush.terrainId, ref.tileCount) : null;
    if (ref && resolve) member = { key, firstGid: ref.firstGid, resolve };
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

/**
 * Paint `cells` with a terrain, or erase them when `terrain` is `null`, then
 * pick the variant of every painted cell and of every terrain tile around them
 * from its 8 neighbours. Neighbours are read across chunk borders and empty
 * chunks; a neighbour joins when it belongs to the same terrain of the same
 * Tileset, and cells outside the map always join, so terrain runs on past the
 * map edge. Cells outside the map are never written. Returns `map` itself when
 * nothing changes, and nothing changes when the terrain has no tiles.
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
    let mask = 0;
    for (const { bit, dx, dy } of TERRAIN_NEIGHBOURS) {
      const x = entry.x + dx;
      const y = entry.y + dy;
      if (!tileInBounds(map, x, y) || memberAt(x, y) === entry.member) mask |= bit;
    }
    writes.push({ x: entry.x, y: entry.y, id: encodeTileGid(entry.member.firstGid, entry.member.resolve(mask)) });
  }
  return setTiles(map, options.layerId, writes, options.index);
}
