/** Terrain (autotile) painting on Tilemap layers; pure and Babylon-free. */

import { tilesetTerrainById, tilesetTileById, type TilesetPayload, type TilesetTerrainStyle } from "./tileset-payload";
import {
  cachedTerrainResolver,
  canonicalTerrainMask,
  TERRAIN_NEIGHBOURS,
  TERRAIN_SIDES,
  tilesetTerrainStamp,
  type TerrainResolver,
} from "./tileset-terrain";
import {
  chunkCoordForTile,
  decodeTileGid,
  encodeTileGid,
  localIndex,
  setTiles,
  tileInBounds,
  tilemapCellKey,
  type TilemapChunkIndex,
  type TilemapLayer,
  type TilemapPayload,
  type TilemapTilesetRef,
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

type TerrainMembers = {
  ofSet: (brush: TilemapTerrainBrush) => TerrainMember | null;
  ofGid: (gid: number) => TerrainMember | null;
};

/**
 * Members by the map's Tileset list and the loaded Tilesets: both are replaced
 * on edit, never changed in place, and decide every answer, so the lookups (and
 * the GIDs they already decoded) carry over from one stroke to the next.
 */
const membersCache = new WeakMap<readonly TilemapTilesetRef[], WeakMap<ReadonlyMap<string, TilesetPayload>, TerrainMembers>>();

/**
 * Terrain lookups for one map and its loaded Tilesets: which terrain a GID
 * belongs to, and the resolver that picks a terrain's variant.
 */
function terrainMembers(map: TilemapPayload, tilesets: ReadonlyMap<string, TilesetPayload>): TerrainMembers {
  let byTilesets = membersCache.get(map.tilesets);
  if (!byTilesets) membersCache.set(map.tilesets, (byTilesets = new WeakMap()));
  let members = byTilesets.get(tilesets);
  if (!members) byTilesets.set(tilesets, (members = buildTerrainMembers(map.tilesets, tilesets)));
  return members;
}

function buildTerrainMembers(refs: readonly TilemapTilesetRef[], tilesets: ReadonlyMap<string, TilesetPayload>): TerrainMembers {
  // Decoding a GID reads only the Tileset list.
  const map = { tilesets: refs } as TilemapPayload;
  const bySet = new Map<string, TerrainMember | null>();
  const byGid = new Map<number, TerrainMember | null>();
  const ofSet = (brush: TilemapTerrainBrush): TerrainMember | null => {
    const key = tilemapTerrainKey(brush);
    let member = bySet.get(key);
    if (member !== undefined) return member;
    member = null;
    const ref = refs.find((entry) => entry.guid === brush.guid);
    const tileset = tilesets.get(brush.guid);
    const terrain = tileset ? tilesetTerrainById(tileset, brush.terrainId) : null;
    const resolver = ref && tileset ? cachedTerrainResolver(tileset, brush.terrainId, ref.tileCount) : null;
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
    // A tile past the atlas draws nothing and is no member, whether or not the payload went through `ensureTilesetTiles`.
    const hit = decodeTileGid(map, gid, tilesets);
    const terrain = hit ? tilesetTileById(hit.tileset, hit.localId)?.terrain : undefined;
    if (hit && terrain) member = ofSet({ guid: hit.guid, terrainId: terrain.id });
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
  let chunkTiles: (key: number) => readonly number[] | undefined;
  if (positions) {
    chunkTiles = (key) => {
      const at = positions.get(key);
      return at === undefined ? undefined : layer.chunks[at]!.tiles;
    };
  } else {
    const chunks = new Map<number, readonly number[]>();
    for (const chunk of layer.chunks) {
      const key = tilemapCellKey(chunk.cx, chunk.cy);
      if (!chunks.has(key)) chunks.set(key, chunk.tiles);
    }
    chunkTiles = (key) => chunks.get(key);
  }
  return (x, y) => {
    const { cx, cy, lx, ly } = chunkCoordForTile(x, y, size);
    return chunkTiles(tilemapCellKey(cx, cy))?.[localIndex(lx, ly, size)] ?? 0;
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
 * What a cell of `member` at (x, y) wants from its 8 neighbours' terrains
 * (`memberAt`; never their variants, so a painted cell changes only itself and
 * its 8 neighbours): the joined bits and the set. Per direction: outside the
 * map (a bounded map's edge; an unbounded map has no outside, so its
 * neighbours are cells like any other) or the same terrain joins; another terrain U of the same Tileset is open
 * facing U when this terrain has a border set for U, else joins when U has a
 * border set for this terrain (U's pieces draw the seam), else is open facing
 * nothing; anything else is open facing nothing. The set is the border faced
 * most often on open sides, or on open corners when every side joins (Blob
 * only); a tie or no border picks the default set (`undefined`).
 */
function terrainCellWant(
  map: TilemapPayload,
  member: TerrainMember,
  x: number,
  y: number,
  memberAt: (x: number, y: number) => TerrainMember | null,
): { mask: number; border: string | undefined } {
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
  return { mask, border };
}

/** The GID a cell of `member` at (x, y) takes from its neighbours (`terrainCellWant`). */
function resolveTerrainCell(
  map: TilemapPayload,
  member: TerrainMember,
  x: number,
  y: number,
  memberAt: (x: number, y: number) => TerrainMember | null,
): number {
  const { mask, border } = terrainCellWant(map, member, x, y, memberAt);
  return encodeTileGid(member.firstGid, member.resolver.resolve(mask, border));
}

/** The piece a terrain cell wants: its terrain, the canonical mask of the neighbours it joins, and its set (`border` omitted: the default set). */
export interface TilemapTerrainCellPiece {
  guid: string;
  terrainId: string;
  mask: number;
  border?: string;
}

/**
 * Reads, for any cell of one layer, the piece painting would resolve there
 * (`terrainCellWant`): `null` outside the map, on an empty or plain cell, or
 * on a terrain without tiles. Reads `map` as it is, with no stale refresh, and
 * shares one set of resolvers across calls.
 */
export function tilemapTerrainCellPieces(
  map: TilemapPayload,
  layerId: string,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): (x: number, y: number) => TilemapTerrainCellPiece | null {
  const layer = map.layers.find((entry) => entry.id === layerId);
  if (!layer) return () => null;
  const members = terrainMembers(map, tilesets);
  const gidAt = layerReader(map, layer);
  const memberAt = (x: number, y: number) => members.ofGid(gidAt(x, y));
  return (x, y) => {
    const member = tileInBounds(map, x, y) ? memberAt(x, y) : null;
    if (!member) return null;
    const { mask, border } = terrainCellWant(map, member, x, y, memberAt);
    const piece: TilemapTerrainCellPiece = {
      guid: member.guid,
      terrainId: member.terrainId,
      mask: canonicalTerrainMask(member.style, mask),
    };
    if (border !== undefined) piece.border = border;
    return piece;
  };
}

/**
 * Paint `cells` with a terrain, or erase them when `terrain` is `null`, then
 * pick the variant of every painted cell and of every terrain tile around them
 * from its 8 neighbours (`resolveTerrainCell`), read across chunk borders and
 * empty chunks. Cells outside a bounded map always join, so terrain runs on
 * past the map edge, and are never written; an unbounded map has no outside,
 * so empty neighbours stay open. A map stale for one of `tilesets` is
 * refreshed first (`refreshStaleTilemapTerrains`), so the result is current
 * with every loaded Tileset. Returns `map` itself when the stroke changes no
 * cell, and nothing changes when the terrain has no tiles.
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
  if (!map.layers.some((entry) => entry.id === options.layerId)) return map;
  const base = refreshStaleTilemapTerrains(map, options.tilesets);
  const layer = base.layers.find((entry) => entry.id === options.layerId)!;
  const members = terrainMembers(base, options.tilesets);
  const brush = options.terrain ? members.ofSet(options.terrain) : null;
  if (options.terrain && !brush) return map;
  // Cells by `tilemapCellKey`, so a large shape builds no strings.
  const targets = new Map<number, { x: number; y: number }>();
  for (const cell of options.cells) {
    if (tileInBounds(base, cell.x, cell.y)) targets.set(tilemapCellKey(cell.x, cell.y), { x: cell.x, y: cell.y });
  }
  if (targets.size === 0) return map;
  const gidAt = layerReader(base, layer, options.index);
  const memberAt = (x: number, y: number): TerrainMember | null =>
    targets.has(tilemapCellKey(x, y)) ? brush : members.ofGid(gidAt(x, y));

  // Painted cells take the brush terrain; terrain tiles around any written cell
  // keep their own terrain and only change variant.
  const resolve = new Map<number, { x: number; y: number; member: TerrainMember }>();
  for (const [key, cell] of targets) {
    if (brush) resolve.set(key, { x: cell.x, y: cell.y, member: brush });
    for (const { dx, dy } of TERRAIN_NEIGHBOURS) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      const neighbourKey = tilemapCellKey(x, y);
      if (targets.has(neighbourKey) || resolve.has(neighbourKey) || !tileInBounds(base, x, y)) continue;
      const member = members.ofGid(gidAt(x, y));
      if (member) resolve.set(neighbourKey, { x, y, member });
    }
  }

  const writes: TileWrite[] = [];
  if (!brush) for (const cell of targets.values()) writes.push({ ...cell, id: 0 });
  for (const entry of resolve.values()) {
    writes.push({ x: entry.x, y: entry.y, id: resolveTerrainCell(base, entry.member, entry.x, entry.y, memberAt) });
  }
  const painted = setTiles(base, options.layerId, writes, options.index);
  return painted === base ? map : painted;
}

/**
 * Re-pick the variants of the terrain tiles around cells of `layerId` that an
 * edit wrote with plain tiles (a selection moved, pasted, cut or deleted), as
 * painting does (`resolveTerrainCell`): every written terrain cell and every
 * terrain tile in the 8-neighbourhood of a written cell takes the variant its
 * neighbours' terrains ask for; cells keep their terrain. `keep` names written
 * cells whose neighbours all moved with them, so their surroundings did not
 * change and they keep their tile (a hand-placed variant inside a moved block
 * stays). Returns `map` itself when no variant changes, at once when none of
 * the map's loaded Tilesets has terrains.
 */
export function resolveTilemapTerrainAround(
  map: TilemapPayload,
  options: {
    layerId: string;
    cells: Iterable<{ x: number; y: number }>;
    keep?: (x: number, y: number) => boolean;
    tilesets: ReadonlyMap<string, TilesetPayload>;
  },
): TilemapPayload {
  const layer = map.layers.find((entry) => entry.id === options.layerId);
  if (!layer || !map.tilesets.some((ref) => (options.tilesets.get(ref.guid)?.terrains?.length ?? 0) > 0)) return map;
  const members = terrainMembers(map, options.tilesets);
  const gidAt = layerReader(map, layer);
  const memberAt = (x: number, y: number) => members.ofGid(gidAt(x, y));
  const written = new Map<number, { x: number; y: number }>();
  for (const cell of options.cells) {
    if (tileInBounds(map, cell.x, cell.y)) written.set(tilemapCellKey(cell.x, cell.y), { x: cell.x, y: cell.y });
  }
  const resolve = new Map<number, { x: number; y: number; member: TerrainMember }>();
  const consider = (x: number, y: number, key: number) => {
    if (resolve.has(key) || !tileInBounds(map, x, y)) return;
    const member = memberAt(x, y);
    if (member) resolve.set(key, { x, y, member });
  };
  for (const [key, cell] of written) {
    if (!options.keep?.(cell.x, cell.y)) consider(cell.x, cell.y, key);
    for (const { dx, dy } of TERRAIN_NEIGHBOURS) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      const neighbourKey = tilemapCellKey(x, y);
      // A written neighbour is resolved, or kept, as a written cell.
      if (!written.has(neighbourKey)) consider(x, y, neighbourKey);
    }
  }
  const writes: TileWrite[] = [];
  for (const entry of resolve.values()) {
    const id = resolveTerrainCell(map, entry.member, entry.x, entry.y, memberAt);
    if (id !== gidAt(entry.x, entry.y)) writes.push({ x: entry.x, y: entry.y, id });
  }
  return writes.length > 0 ? setTiles(map, options.layerId, writes) : map;
}

/**
 * Bring a map's terrain cells up to date with its Tilesets. Each Tileset in
 * `tilesets` whose `tilesetTerrainStamp` differs from its ref's
 * `terrainStamp` (a ref without one is stale) has its terrain cells on every
 * layer re-resolved from their neighbours, as painting would, and its ref
 * takes the new stamp. Cells of other Tilesets, of Tilesets missing from
 * `tilesets`, and of terrains that no longer exist or have no tiles stay as
 * they are. Returns `map` itself when every stamp matches, after work per
 * Tileset only; otherwise one pass over the cells.
 */
export function refreshStaleTilemapTerrains(
  map: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): TilemapPayload {
  let stale: Map<string, string> | null = null;
  for (const ref of map.tilesets) {
    const tileset = tilesets.get(ref.guid);
    if (!tileset) continue;
    const stamp = tilesetTerrainStamp(tileset);
    if (ref.terrainStamp !== stamp) (stale ??= new Map()).set(ref.guid, stamp);
  }
  if (!stale) return map;
  const stamps: ReadonlyMap<string, string> = stale;
  // A stale Tileset without terrains has no terrain cells to re-resolve.
  const resolved = [...stamps.keys()].some((guid) => (tilesets.get(guid)?.terrains?.length ?? 0) > 0)
    ? resolveTerrainCells(map, tilesets, stamps)
    : map;
  return {
    ...resolved,
    tilesets: resolved.tilesets.map((ref) => {
      const terrainStamp = stamps.get(ref.guid);
      return terrainStamp === undefined ? ref : { ...ref, terrainStamp };
    }),
  };
}

/**
 * Every map of a load refreshed against the same Tilesets
 * (`refreshStaleTilemapTerrains`): where a load meets its Tilemap and Tileset
 * payloads, so every view of a map draws, collides and bakes the same cells.
 */
export function refreshStaleTilemaps(
  tilemaps: ReadonlyMap<string, TilemapPayload>,
  tilesets: ReadonlyMap<string, TilesetPayload>,
): Map<string, TilemapPayload> {
  return new Map([...tilemaps].map(([guid, map]) => [guid, refreshStaleTilemapTerrains(map, tilesets)]));
}

/** Re-resolve every terrain cell of the Tilesets named in `guids`, on every layer; `map` itself when none changes. */
function resolveTerrainCells(
  map: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload>,
  guids: ReadonlyMap<string, unknown>,
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
        if (!member || !guids.has(member.guid)) return;
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
