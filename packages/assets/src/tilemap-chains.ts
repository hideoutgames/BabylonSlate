import { tilesetTileById, type TilesetPayload } from "./tileset-payload";
import {
  decodeTileGid,
  tilemapTilesetGuids,
  type TilemapPayload,
} from "./tilemap-payload";

export interface TilemapChain {
  points: Array<{ x: number; y: number }>;
  loop: boolean;
}

type Point = { x: number; y: number };

type GidResolver = (
  gid: number,
) => { tileset: TilesetPayload; localId: number; guid: string } | null;

interface ChainChunk {
  cx: number;
  cy: number;
  tiles: readonly number[];
}

/**
 * Merge the solid tiles of `chunks` into Rapier chain polylines, measured
 * from the `origin` chunk. Shared edges cancel, across chunk borders too;
 * collinear outer edges collapse so a solid rectangle is one four-point loop
 * rather than a box per tile.
 */
function chainsForChunks(options: {
  chunks: readonly ChainChunk[];
  origin: { cx: number; cy: number };
  chunkSize: number;
  tileset: TilesetPayload;
  worldTileWidth: number;
  worldTileHeight: number;
  resolveGid?: GidResolver;
}): TilemapChain[] {
  const { chunks, origin, chunkSize, tileset, worldTileWidth, worldTileHeight, resolveGid } = options;
  const originX = origin.cx * chunkSize * worldTileWidth;
  const originY = origin.cy * chunkSize * worldTileHeight;
  const unitEdges: Array<[Point, Point]> = [];
  const custom: TilemapChain[] = [];

  for (const chunk of chunks) {
    // Tile offset of this chunk from the origin chunk, in whole tiles.
    const offsetX = (chunk.cx - origin.cx) * chunkSize;
    const offsetY = (chunk.cy - origin.cy) * chunkSize;
    for (let ly = 0; ly < chunkSize; ly++) {
      for (let lx = 0; lx < chunkSize; lx++) {
        const tileId = chunk.tiles[ly * chunkSize + lx] ?? 0;
        if (tileId <= 0) continue;
        const resolved = resolveGid?.(tileId);
        if (resolveGid && !resolved) continue;
        const atlas = resolved?.tileset ?? tileset;
        const localId = resolved?.localId ?? tileId;
        const def = tilesetTileById(atlas, localId);
        if (!def) continue;
        const gx = offsetX + lx;
        const gy = offsetY + ly;
        if (def.collision === "full") {
          // Merge in integer grid space: adjacent world-space endpoints can
          // otherwise differ by rounding at fractional pixels-per-unit scales.
          unitEdges.push(
            [{ x: gx, y: gy }, { x: gx + 1, y: gy }],
            [{ x: gx + 1, y: gy }, { x: gx + 1, y: gy + 1 }],
            [{ x: gx + 1, y: gy + 1 }, { x: gx, y: gy + 1 }],
            [{ x: gx, y: gy + 1 }, { x: gx, y: gy }],
          );
          continue;
        }
        if (def.collision !== "none" && def.collision.kind === "chain") {
          custom.push({
            loop: false,
            points: def.collision.points.map((point) => ({
              x: originX + (gx + point.x) * worldTileWidth,
              y: originY + (gy + point.y) * worldTileHeight,
            })),
          });
        }
      }
    }
  }

  const outlines = outlineChains(unitEdges).map((chain) => ({
    ...chain,
    points: chain.points.map((point) => ({
      x: originX + point.x * worldTileWidth,
      y: originY + point.y * worldTileHeight,
    })),
  }));
  return [...outlines, ...custom.filter((c) => c.points.length >= 2)];
}

/** Merge solid tiles in one chunk into Rapier chain polylines. */
export function tilemapChunkChains(options: {
  tiles: readonly number[];
  chunkSize: number;
  chunkX: number;
  chunkY: number;
  tileset: TilesetPayload;
  worldTileWidth: number;
  worldTileHeight: number;
  resolveGid?: GidResolver;
}): TilemapChain[] {
  const origin = { cx: options.chunkX, cy: options.chunkY };
  return chainsForChunks({ ...options, chunks: [{ ...origin, tiles: options.tiles }], origin });
}

/**
 * Merge a layer's solid tiles across all its chunks, so a floor that spans a
 * chunk border is one outline with no edge at the border for a body to catch on.
 */
export function tilemapLayerChains(options: {
  chunks: readonly ChainChunk[];
  chunkSize: number;
  tileset: TilesetPayload;
  worldTileWidth: number;
  worldTileHeight: number;
  resolveGid?: GidResolver;
}): TilemapChain[] {
  return chainsForChunks({ ...options, origin: { cx: 0, cy: 0 } });
}

/** Collision-layer chains for a tilemap, merged per layer (nav bake / Rapier). */
export function tilemapCollisionChains(
  map: TilemapPayload,
  tileset: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
  worldTileWidth: number,
  worldTileHeight: number,
): TilemapChain[] {
  const tilesets =
    tileset instanceof Map || isTilesetMap(tileset)
      ? tileset
      : null;
  const fallback = tilesets ? undefined : (tileset as TilesetPayload);
  const resolveGid = tilesets
    ? (gid: number) => {
        const hit = decodeTileGid(map, gid, tilesets);
        return hit;
      }
    : undefined;
  const atlas = fallback ?? firstTileset(map, tilesets);
  if (!atlas) return [];
  const chains: TilemapChain[] = [];
  for (const layer of map.layers) {
    if (!layer.collision) continue;
    chains.push(
      ...tilemapLayerChains({
        chunks: layer.chunks,
        chunkSize: map.chunkSize,
        tileset: atlas,
        worldTileWidth,
        worldTileHeight,
        resolveGid,
      }),
    );
  }
  return chains;
}

function isTilesetMap(
  value: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
): value is ReadonlyMap<string, TilesetPayload> {
  return (
    typeof (value as ReadonlyMap<string, TilesetPayload>).get === "function" &&
    !Array.isArray((value as TilesetPayload).tiles)
  );
}

function firstTileset(
  map: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload> | null,
): TilesetPayload | undefined {
  if (!tilesets) return undefined;
  for (const guid of tilemapTilesetGuids(map)) {
    const tileset = tilesets.get(guid);
    if (tileset) return tileset;
  }
  return tilesets.values().next().value;
}

function outlineChains(directed: Array<[Point, Point]>): TilemapChain[] {
  const remaining = new Map<string, [Point, Point]>();
  for (const [from, to] of directed) {
    const forward = edgeKey(from, to);
    const backward = edgeKey(to, from);
    if (remaining.has(backward)) {
      remaining.delete(backward);
      continue;
    }
    remaining.set(forward, [from, to]);
  }

  const adj = new Map<string, Point[]>();
  for (const [from, to] of remaining.values()) {
    pushAdj(adj, from, to);
    pushAdj(adj, to, from);
  }

  const used = new Set<string>();
  const chains: TilemapChain[] = [];
  for (const [from, to] of remaining.values()) {
    const startKey = undirectedKey(from, to);
    if (used.has(startKey)) continue;
    const walked = walkOutline(from, adj, used, remaining.size);
    if (walked.points.length >= 3) chains.push(walked);
  }
  return chains;
}

/** Each step uses up one edge, so `edgeCount` steps finish any outline (a layer's can be long). */
function walkOutline(
  start: Point,
  adj: Map<string, Point[]>,
  used: Set<string>,
  edgeCount: number,
): TilemapChain {
  const points: Point[] = [start];
  let prev: Point | null = null;
  let curr = start;
  for (let guard = 0; guard < edgeCount; guard++) {
    const neighbors = adj.get(pointKey(curr)) ?? [];
    const next =
      neighbors.find(
        (candidate) =>
          !used.has(undirectedKey(curr, candidate)) &&
          (prev === null || pointKey(candidate) !== pointKey(prev)),
      ) ??
      neighbors.find((candidate) => !used.has(undirectedKey(curr, candidate)));
    if (!next) break;
    used.add(undirectedKey(curr, next));
    points.push(next);
    prev = curr;
    curr = next;
    if (pointKey(curr) === pointKey(start) && points.length > 2) break;
  }
  const loop =
    points.length > 2 &&
    pointKey(points[0]!) === pointKey(points[points.length - 1]!);
  const ring = loop ? points.slice(0, -1) : points;
  return { points: simplifyCollinear(ring, loop), loop };
}

function simplifyCollinear(points: Point[], loop: boolean): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const prev = points[loop ? (i - 1 + count) % count : i - 1];
    const curr = points[i]!;
    const next = points[loop ? (i + 1) % count : i + 1];
    if (!prev || !next) {
      out.push(curr);
      continue;
    }
    if (collinear(prev, curr, next)) continue;
    out.push(curr);
  }
  return out.length >= 3 ? out : points;
}

function collinear(a: Point, b: Point, c: Point): boolean {
  const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  return Math.abs(cross) < 1e-9;
}

function pushAdj(adj: Map<string, Point[]>, from: Point, to: Point): void {
  const key = pointKey(from);
  const list = adj.get(key) ?? [];
  list.push(to);
  adj.set(key, list);
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function edgeKey(from: Point, to: Point): string {
  return `${pointKey(from)}>${pointKey(to)}`;
}

function undirectedKey(a: Point, b: Point): string {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}
