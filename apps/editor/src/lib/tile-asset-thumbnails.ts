import {
  chunkCoordForTile,
  decodeTileGid,
  DEFAULT_THUMBNAIL_MAX_EDGE,
  DOCUMENT_CHUNK_ID,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  orderedTilemapLayers,
  tilemapPaintedExtent,
  tilemapTilesetGuids,
  tilePlaceholderHsl,
  tilesetTileRect,
  type IndexedAsset,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import { DEFAULT_SORTING_LAYERS } from "@haptic/core";
import { createAssetThumbnailRevisionIndex } from "./asset-thumbnail-revision";
import type { ModelThumbnailJob } from "./model-thumbnail-queue";

/** A decoded atlas image and its size in pixels. */
export interface ThumbnailAtlas {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** The drawing a thumbnail does: a canvas context or a test's recorder. */
export type ThumbnailContext = Pick<CanvasRenderingContext2D, "drawImage" | "fillRect" | "fillStyle" | "imageSmoothingEnabled">;

/** A thumbnail's size and how to draw it. */
export interface ThumbnailPlan {
  width: number;
  height: number;
  draw(ctx: ThumbnailContext): void;
}

const TILE_THUMBNAIL_TYPES = new Set(["Tileset", "Tilemap"]);

/** Asset types whose thumbnail is drawn in 2D from their tiles, without the Engine. */
export function isTileThumbnailType(type: string): type is "Tileset" | "Tilemap" {
  return TILE_THUMBNAIL_TYPES.has(type);
}

function hsl(color: { h: number; s: number; l: number }): string {
  return `hsl(${color.h} ${color.s}% ${color.l}%)`;
}

/** `width` × `height` scaled so its longer side is `maxEdge`. */
function fit(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
  const scale = maxEdge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * A Tileset's thumbnail: the part of its atlas image the sheet covers, fitted
 * into `maxEdge`. `null` when that part is empty.
 */
export function tilesetThumbnailPlan(
  tileset: TilesetPayload,
  atlas: ThumbnailAtlas,
  maxEdge = DEFAULT_THUMBNAIL_MAX_EDGE,
): ThumbnailPlan | null {
  const width = Math.min(tileset.atlasWidth, atlas.width);
  const height = Math.min(tileset.atlasHeight, atlas.height);
  if (width <= 0 || height <= 0) return null;
  const size = fit(width, height, maxEdge);
  return {
    width: size.width,
    height: size.height,
    draw(ctx) {
      ctx.imageSmoothingEnabled = size.scale < 1;
      ctx.drawImage(atlas.image, 0, 0, width, height, 0, 0, size.width, size.height);
    },
  };
}

type GidDraw =
  | { atlas: ThumbnailAtlas; sx: number; sy: number; sw: number; sh: number }
  | { color: string; atlas?: undefined };

/**
 * A Tilemap's thumbnail: the cells its visible layers paint (inside the map
 * when it is bounded), layers in sorting order, fitted into `maxEdge` with the
 * map's tile proportions. A tile without an atlas image is its placeholder
 * colour, as in Paint. A map wider or taller than `maxEdge` cells draws one
 * cell of each block that shares a pixel. `null` when nothing is painted.
 */
export function tilemapThumbnailPlan(
  map: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload>,
  atlases: ReadonlyMap<string, ThumbnailAtlas>,
  sortingLayers: readonly string[] = DEFAULT_SORTING_LAYERS,
  maxEdge = DEFAULT_THUMBNAIL_MAX_EDGE,
): ThumbnailPlan | null {
  const layers = orderedTilemapLayers(map, sortingLayers).filter((layer) => layer.visible);
  const painted = tilemapPaintedExtent({ layers, chunkSize: map.chunkSize });
  if (!painted) return null;
  const extent = map.unbounded
    ? painted
    : { minX: Math.max(0, painted.minX), minY: Math.max(0, painted.minY), maxX: Math.min(map.width - 1, painted.maxX), maxY: Math.min(map.height - 1, painted.maxY) };
  if (extent.minX > extent.maxX || extent.minY > extent.maxY) return null;
  const columns = extent.maxX - extent.minX + 1;
  const rows = extent.maxY - extent.minY + 1;
  const tileWidth = Math.max(1, map.tileWidth);
  const tileHeight = Math.max(1, map.tileHeight);
  const size = fit(columns * tileWidth, rows * tileHeight, maxEdge);
  // Thumbnail pixels per cell, and cells per drawn block when a cell is under a pixel.
  const cellX = size.width / columns;
  const cellY = size.height / rows;
  const stepX = Math.max(1, Math.ceil(1 / cellX));
  const stepY = Math.max(1, Math.ceil(1 / cellY));
  const chunkSize = Math.max(1, map.chunkSize);
  const draws = new Map<number, GidDraw>();
  const drawFor = (gid: number): GidDraw => {
    let draw = draws.get(gid);
    if (draw) return draw;
    const hit = decodeTileGid(map, gid, tilesets);
    const atlas = hit ? atlases.get(hit.guid) : undefined;
    // Animated tiles show their own (first) cell, as in Paint.
    const rect = hit && atlas ? tilesetTileRect(hit.tileset, hit.localId) : null;
    draw = atlas && rect
      ? { atlas, sx: rect.x, sy: rect.y, sw: rect.width, sh: rect.height }
      : { color: hsl(tilePlaceholderHsl(gid)) };
    draws.set(gid, draw);
    return draw;
  };
  return {
    width: size.width,
    height: size.height,
    draw(ctx) {
      ctx.imageSmoothingEnabled = size.scale < 1;
      for (const layer of layers) {
        const chunks = new Map(layer.chunks.map((chunk) => [`${chunk.cx},${chunk.cy}`, chunk.tiles] as const));
        // Row 0 of the thumbnail is the top row of cells (+Y up).
        for (let row = 0; row < rows; row += stepY) {
          const top = Math.round(row * cellY);
          const bottom = Math.round(Math.min(rows, row + stepY) * cellY);
          for (let column = 0; column < columns; column += stepX) {
            const coord = chunkCoordForTile(extent.minX + column, extent.maxY - row, chunkSize);
            const gid = chunks.get(`${coord.cx},${coord.cy}`)?.[coord.ly * chunkSize + coord.lx] ?? 0;
            if (gid <= 0) continue;
            const left = Math.round(column * cellX);
            const right = Math.round(Math.min(columns, column + stepX) * cellX);
            const draw = drawFor(gid);
            if (draw.atlas) {
              ctx.drawImage(draw.atlas.image, draw.sx, draw.sy, draw.sw, draw.sh, left, top, right - left, bottom - top);
            } else {
              ctx.fillStyle = draw.color;
              ctx.fillRect(left, top, right - left, bottom - top);
            }
          }
        }
      }
    },
  };
}

/** A plan drawn on an `OffscreenCanvas` as PNG bytes, or `null` where the host has no 2D canvas. */
async function encodeThumbnailPlan(plan: ThumbnailPlan): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  plan.draw(ctx);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

export interface TileAssetThumbnailOptions {
  asset: IndexedAsset;
  registry: { getByGuid(guid: string): IndexedAsset | undefined };
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  /** The project's sorting layers, which order a Tilemap's layers. */
  sortingLayers?: readonly string[];
  shouldContinue?: () => boolean;
}

/**
 * Draws a saved Tileset's or Tilemap's thumbnail from its document, its
 * Tilesets' documents and their Textures' pixels. `null` (the type icon) when
 * there is nothing to draw, a Tileset has no Texture, a Texture's pixels
 * cannot be read or decoded (a later save draws it again), the host has no 2D
 * canvas, or `shouldContinue` turned false.
 */
export async function generateTileAssetThumbnail(options: TileAssetThumbnailOptions): Promise<Uint8Array | null> {
  const { asset, registry, readAssetChunk } = options;
  const current = options.shouldContinue ?? (() => true);
  const bitmaps: ImageBitmap[] = [];
  const readDocument = async (entry: IndexedAsset): Promise<unknown> => {
    if (!entry.header.chunks.some((chunk) => chunk.id === DOCUMENT_CHUNK_ID)) return entry.header.payload;
    const bytes = await readAssetChunk(entry.path, DOCUMENT_CHUNK_ID);
    if (!bytes?.byteLength) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  };
  /** The Tileset's atlas; `null` when it has no Texture, `undefined` when its pixels are unreadable. */
  const atlasFor = async (tileset: TilesetPayload): Promise<ThumbnailAtlas | null | undefined> => {
    const texture = tileset.textureGuid ? registry.getByGuid(tileset.textureGuid) : undefined;
    if (!texture || texture.header.type !== "Texture") return null;
    const bytes = await readAssetChunk(texture.path, "pixels");
    if (!bytes?.byteLength || typeof createImageBitmap !== "function") return undefined;
    const mime = texture.header.chunks.find((chunk) => chunk.id === "pixels")?.mime ?? "image/png";
    try {
      const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
      bitmaps.push(bitmap);
      return { image: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      return undefined;
    }
  };
  try {
    let plan: ThumbnailPlan | null = null;
    if (asset.header.type === "Tileset") {
      const document = await readDocument(asset);
      if (document === null || !current()) return null;
      const tileset = normalizeTilesetPayload(document);
      const atlas = await atlasFor(tileset);
      if (!atlas || !current()) return null;
      plan = tilesetThumbnailPlan(tileset, atlas);
    } else if (asset.header.type === "Tilemap") {
      const document = await readDocument(asset);
      if (document === null || !current()) return null;
      const map = normalizeTilemapPayload(document);
      const tilesets = new Map<string, TilesetPayload>();
      const atlases = new Map<string, ThumbnailAtlas>();
      for (const guid of tilemapTilesetGuids(map)) {
        const entry = registry.getByGuid(guid);
        // A missing Tileset's cells draw their placeholder colour.
        if (entry?.header.type !== "Tileset") continue;
        const tilesetDocument = await readDocument(entry);
        if (tilesetDocument === null || !current()) return null;
        const tileset = normalizeTilesetPayload(tilesetDocument);
        tilesets.set(guid, tileset);
        // A Tileset without a Texture paints its placeholder colours.
        const atlas = await atlasFor(tileset);
        if (atlas === undefined || !current()) return null;
        if (atlas) atlases.set(guid, atlas);
      }
      plan = tilemapThumbnailPlan(map, tilesets, atlases, options.sortingLayers);
    }
    if (!plan || !current()) return null;
    return await encodeThumbnailPlan(plan);
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

/**
 * The Tilesets and Tilemaps whose thumbnails show any of `changed`: those
 * assets themselves and every Tileset or Tilemap that depends on one, directly
 * or through others (a Texture's Tilesets and their Tilemaps).
 */
export function tileThumbnailTargets(assets: readonly IndexedAsset[], changed: Iterable<string>): IndexedAsset[] {
  const byGuid = new Map(assets.map((asset) => [asset.header.guid, asset] as const));
  const dependents = new Map<string, string[]>();
  for (const asset of assets) {
    for (const dependency of asset.header.dependencies) {
      const list = dependents.get(dependency);
      if (list) list.push(asset.header.guid);
      else dependents.set(dependency, [asset.header.guid]);
    }
  }
  const visited = new Set<string>();
  const pending = [...changed];
  const targets: IndexedAsset[] = [];
  while (pending.length) {
    const guid = pending.pop()!;
    if (visited.has(guid)) continue;
    visited.add(guid);
    const asset = byGuid.get(guid);
    if (asset && isTileThumbnailType(asset.header.type)) targets.push(asset);
    pending.push(...(dependents.get(guid) ?? []));
  }
  return targets;
}

/** Thumbnail jobs for `tileThumbnailTargets`, each keyed by its saved revision. */
export async function tileThumbnailJobs(
  assets: readonly IndexedAsset[],
  changed: Iterable<string>,
  projectGuid: string,
  pixelsPerUnit?: number,
): Promise<ModelThumbnailJob[]> {
  const targets = tileThumbnailTargets(assets, changed);
  if (targets.length === 0) return [];
  const revisions = createAssetThumbnailRevisionIndex(assets, pixelsPerUnit);
  return Promise.all(targets.map(async (asset) => ({
    guid: asset.header.guid,
    path: asset.path,
    type: asset.header.type as "Tileset" | "Tilemap",
    payload: {},
    projectGuid,
    cacheKey: (await revisions.cacheKey(asset.header.guid)) ?? asset.header.guid,
  })));
}
