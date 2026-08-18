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

/**
 * Merge solid tiles in a chunk into Rapier chain polylines.
 * Shared edges cancel; collinear outer edges collapse so a solid rectangle
 * is one four-point loop rather than a box per tile.
 */
export function tilemapChunkChains(options: {
  tiles: readonly number[];
  chunkSize: number;
  chunkX: number;
  chunkY: number;
  tileset: TilesetPayload;
  worldTileWidth: number;
  worldTileHeight: number;
  resolveGid?: (
    gid: number,
  ) => { tileset: TilesetPayload; localId: number; guid: string } | null;
}): TilemapChain[] {
  const {
    tiles,
    chunkSize,
    chunkX,
    chunkY,
    tileset,
    worldTileWidth,
    worldTileHeight,
    resolveGid,
  } = options;
  const originX = chunkX * chunkSize * worldTileWidth;
  const originY = chunkY * chunkSize * worldTileHeight;
  const unitEdges: Array<[Point, Point]> = [];
  const custom: TilemapChain[] = [];

  for (let ly = 0; ly < chunkSize; ly++) {
    for (let lx = 0; lx < chunkSize; lx++) {
      const tileId = tiles[ly * chunkSize + lx] ?? 0;
      if (tileId <= 0) continue;
      const resolved = resolveGid?.(tileId);
      if (resolveGid && !resolved) continue;
      const atlas = resolved?.tileset ?? tileset;
      const localId = resolved?.localId ?? tileId;
      const def = tilesetTileById(atlas, localId);
      if (!def) continue;
      const x0 = originX + lx * worldTileWidth;
      const y0 = originY + ly * worldTileHeight;
      if (def.collision === "full") {
        const x1 = x0 + worldTileWidth;
        const y1 = y0 + worldTileHeight;
        unitEdges.push(
          [{ x: x0, y: y0 }, { x: x1, y: y0 }],
          [{ x: x1, y: y0 }, { x: x1, y: y1 }],
          [{ x: x1, y: y1 }, { x: x0, y: y1 }],
          [{ x: x0, y: y1 }, { x: x0, y: y0 }],
        );
        continue;
      }
      if (def.collision !== "none" && def.collision.kind === "chain") {
        custom.push({
          loop: false,
          points: def.collision.points.map((point) => ({
            x: x0 + point.x * worldTileWidth,
            y: y0 + point.y * worldTileHeight,
          })),
        });
      }
    }
  }

  return [...outlineChains(unitEdges), ...custom.filter((c) => c.points.length >= 2)];
}

/** Collision-layer chains for every chunk in a tilemap (nav bake / Rapier). */
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
  const chains: TilemapChain[] = [];
  for (const layer of map.layers) {
    if (!layer.collision) continue;
    for (const chunk of layer.chunks) {
      const atlas = fallback ?? firstTileset(map, tilesets);
      if (!atlas) continue;
      chains.push(
        ...tilemapChunkChains({
          tiles: chunk.tiles,
          chunkSize: map.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset: atlas,
          worldTileWidth,
          worldTileHeight,
          resolveGid,
        }),
      );
    }
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
    const walked = walkOutline(from, adj, used);
    if (walked.points.length >= 3) chains.push(walked);
  }
  return chains;
}

function walkOutline(
  start: Point,
  adj: Map<string, Point[]>,
  used: Set<string>,
): TilemapChain {
  const points: Point[] = [start];
  let prev: Point | null = null;
  let curr = start;
  for (let guard = 0; guard < 10_000; guard++) {
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
