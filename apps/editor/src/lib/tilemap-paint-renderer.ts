import {
  decodeTileGid,
  orderedTilemapLayers,
  tilePlaceholderHsl,
  tilemapCellKey,
  tilesetTileRect,
  type TilemapChunk,
  type TilemapPayload,
  type TilemapTilesetRef,
  type TilesetPayload,
} from "@haptic/assets";

/** An offscreen bitmap a chunk is drawn into once and composited from. */
export type PaintSurface = HTMLCanvasElement | OffscreenCanvas;
export type CreatePaintSurface = (width: number, height: number) => PaintSurface;

type SurfaceContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** How one GID draws: a source rect of its atlas, or its placeholder colour while there is none. */
type GidDraw =
  | { image: CanvasImageSource; sx: number; sy: number; sw: number; sh: number; color?: undefined }
  | { color: string; image?: undefined };

/** Stand-in fill for a tile whose Tileset has no atlas image; chunk meshes draw the same colour. */
export function placeholderCss(gid: number): string {
  const { h, s, l } = tilePlaceholderHsl(gid);
  return `hsl(${h} ${s}% ${l}%)`;
}

/**
 * GID → draw for one map's Tileset list, loaded Tilesets and atlases, filled
 * on first use. Those three are replaced (never changed in place) when they
 * change, so one table holds while they are the same objects.
 */
class GidTable {
  private readonly draws = new Map<number, GidDraw>();
  readonly refs: readonly TilemapTilesetRef[];
  readonly payloads: ReadonlyMap<string, TilesetPayload>;
  readonly atlases: ReadonlyMap<string, HTMLImageElement>;

  constructor(
    refs: readonly TilemapTilesetRef[],
    payloads: ReadonlyMap<string, TilesetPayload>,
    atlases: ReadonlyMap<string, HTMLImageElement>,
  ) {
    this.refs = refs;
    this.payloads = payloads;
    this.atlases = atlases;
  }

  get(gid: number): GidDraw {
    let draw = this.draws.get(gid);
    if (draw) return draw;
    const hit = decodeTileGid({ tilesets: this.refs } as TilemapPayload, gid, this.payloads);
    const atlas = hit ? this.atlases.get(hit.guid) : undefined;
    // Animated tiles keep their own (first) cell in the editor.
    const rect = hit && atlas && atlas.naturalWidth > 0 ? tilesetTileRect(hit.tileset, hit.localId) : null;
    draw = atlas && rect
      ? { image: atlas, sx: rect.x, sy: rect.y, sw: rect.width, sh: rect.height }
      : { color: placeholderCss(gid) };
    this.draws.set(gid, draw);
    return draw;
  }
}

/** A chunk's bitmap and what it was drawn from; reused while all of these are the same. */
interface ChunkBitmap {
  tiles: readonly number[];
  table: GidTable;
  /** Bitmap pixels per cell. */
  cell: number;
  /** Cells of the chunk inside the map, columns and rows from its bottom-left. */
  columns: number;
  rows: number;
  surface: PaintSurface;
  context: SurfaceContext | null;
  /** The last frame that composited it. */
  used: number;
}

export interface TilemapPaintFrame {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  tilemap: TilemapPayload;
  pan: { x: number; y: number };
  cellSize: number;
  payloads: ReadonlyMap<string, TilesetPayload>;
  atlases: ReadonlyMap<string, HTMLImageElement>;
  sortingLayers: readonly string[];
  /** Cells a shape stroke will paint, outlined over the map until it is released. */
  preview?: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/** What a frame cost: chunk bitmaps composited, and chunk bitmaps (re)drawn tile by tile. */
export interface TilemapPaintStats {
  composited: number;
  rendered: number;
}

/** Largest chunk bitmap side; big chunks draw fewer bitmap pixels per cell. */
const MAX_SURFACE_SIDE = 1024;
/** Most bitmap pixels per cell: atlases of larger tiles draw scaled down. */
const MAX_CELL_PIXELS = 32;
const DEFAULT_BUDGET_BYTES = 192 * 1024 * 1024;

/**
 * Draws the Tilemap Paint canvas. Each visible chunk of each visible layer is
 * drawn tile by tile into its own bitmap once, keyed on its `tiles` array (an
 * edit replaces only the chunks it touches), its part inside the map and the
 * GID table; a frame then composites one bitmap per chunk, so a pan, a zoom or
 * a stroke redraws only the chunks whose cells changed. Only chunks in view are
 * drawn; bitmaps not drawn in the latest frame are dropped, oldest first, while
 * all of them together pass `budgetBytes`.
 */
export class TilemapPaintRenderer {
  private readonly bitmaps = new Map<string, Map<number, ChunkBitmap>>();
  private table: GidTable | null = null;
  private frame = 0;
  private bytes = 0;

  private readonly createSurface: CreatePaintSurface;
  private readonly budgetBytes: number;

  constructor(createSurface: CreatePaintSurface, budgetBytes = DEFAULT_BUDGET_BYTES) {
    this.createSurface = createSurface;
    this.budgetBytes = budgetBytes;
  }

  draw(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame): TilemapPaintStats {
    const { cssWidth, cssHeight, dpr, tilemap, pan, cellSize } = frame;
    const stats: TilemapPaintStats = { composited: 0, rendered: 0 };
    this.frame += 1;
    const table = this.tableFor(tilemap.tilesets, frame.payloads, frame.atlases);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "oklch(0.2 0 0)";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.imageSmoothingEnabled = false;
    const size = Math.max(1, tilemap.chunkSize);
    const chunkPixels = size * cellSize;
    const cell = bitmapCellPixels(tilemap, frame.payloads, size);
    for (const layer of orderedTilemapLayers(tilemap, frame.sortingLayers)) {
      if (!layer.visible) continue;
      for (const chunk of layer.chunks) {
        const left = chunk.cx * chunkPixels + pan.x;
        const bottom = cssHeight - chunk.cy * chunkPixels - pan.y;
        if (left + chunkPixels < 0 || left > cssWidth || bottom < 0 || bottom - chunkPixels > cssHeight) continue;
        const bitmap = this.bitmapFor(layer.id, chunk, tilemap, size, cell, table, stats);
        if (!bitmap) continue;
        // The bitmap holds the chunk's in-map columns and rows, from its bottom-left.
        const width = bitmap.columns * bitmap.cell;
        const height = bitmap.rows * bitmap.cell;
        ctx.drawImage(
          bitmap.surface,
          0, bitmap.surface.height - height, width, height,
          left, bottom - bitmap.rows * cellSize, bitmap.columns * cellSize, bitmap.rows * cellSize,
        );
        stats.composited += 1;
      }
    }
    if (frame.preview) drawPreview(ctx, frame);
    drawGrid(ctx, frame);
    this.evict();
    return stats;
  }

  /** Drop every bitmap. */
  dispose(): void {
    this.bitmaps.clear();
    this.bytes = 0;
    this.table = null;
  }

  /** Bitmaps currently kept, for tests and the memory budget. */
  get bitmapCount(): number {
    let count = 0;
    for (const layer of this.bitmaps.values()) count += layer.size;
    return count;
  }

  private tableFor(
    refs: readonly TilemapTilesetRef[],
    payloads: ReadonlyMap<string, TilesetPayload>,
    atlases: ReadonlyMap<string, HTMLImageElement>,
  ): GidTable {
    const table = this.table;
    if (table && table.refs === refs && table.payloads === payloads && table.atlases === atlases) return table;
    return (this.table = new GidTable(refs, payloads, atlases));
  }

  private bitmapFor(
    layerId: string,
    chunk: TilemapChunk,
    tilemap: TilemapPayload,
    size: number,
    cell: number,
    table: GidTable,
    stats: TilemapPaintStats,
  ): ChunkBitmap | null {
    const columns = Math.min(size, tilemap.width - chunk.cx * size);
    const rows = Math.min(size, tilemap.height - chunk.cy * size);
    if (columns <= 0 || rows <= 0 || chunk.cx < 0 || chunk.cy < 0) return null;
    let layer = this.bitmaps.get(layerId);
    if (!layer) this.bitmaps.set(layerId, (layer = new Map()));
    const key = tilemapCellKey(chunk.cx, chunk.cy);
    let bitmap = layer.get(key);
    if (
      bitmap && bitmap.tiles === chunk.tiles && bitmap.table === table &&
      bitmap.cell === cell && bitmap.columns === columns && bitmap.rows === rows
    ) {
      bitmap.used = this.frame;
      return bitmap;
    }
    const side = size * cell;
    if (!bitmap || bitmap.surface.width !== side || bitmap.surface.height !== side) {
      if (bitmap) this.bytes -= surfaceBytes(bitmap.surface);
      const surface = this.createSurface(side, side);
      this.bytes += surfaceBytes(surface);
      bitmap = {
        tiles: chunk.tiles, table, cell, columns, rows, surface,
        context: surface.getContext("2d") as SurfaceContext | null,
        used: this.frame,
      };
      layer.set(key, bitmap);
    }
    Object.assign(bitmap, { tiles: chunk.tiles, table, cell, columns, rows, used: this.frame });
    renderChunk(bitmap, chunk.tiles, size, table);
    stats.rendered += 1;
    return bitmap;
  }

  /** Over budget, drop bitmaps the latest frame did not draw, least recently drawn first. */
  private evict(): void {
    if (this.bytes <= this.budgetBytes) return;
    const idle: Array<{ layer: Map<number, ChunkBitmap>; key: number; bitmap: ChunkBitmap }> = [];
    for (const layer of this.bitmaps.values()) {
      for (const [key, bitmap] of layer) if (bitmap.used < this.frame) idle.push({ layer, key, bitmap });
    }
    idle.sort((a, b) => a.bitmap.used - b.bitmap.used);
    for (const { layer, key, bitmap } of idle) {
      if (this.bytes <= this.budgetBytes) break;
      layer.delete(key);
      this.bytes -= surfaceBytes(bitmap.surface);
    }
  }
}

function surfaceBytes(surface: PaintSurface): number {
  return surface.width * surface.height * 4;
}

/** Bitmap pixels per cell: the largest tile side of the map's Tilesets, within the bitmap size limits. */
function bitmapCellPixels(tilemap: TilemapPayload, payloads: ReadonlyMap<string, TilesetPayload>, size: number): number {
  let tile = 1;
  for (const ref of tilemap.tilesets) {
    const payload = payloads.get(ref.guid);
    if (payload) tile = Math.max(tile, payload.tileWidth, payload.tileHeight);
  }
  if (tile <= 1) tile = Math.max(tilemap.tileWidth, tilemap.tileHeight);
  return Math.max(1, Math.min(tile, MAX_CELL_PIXELS, Math.floor(MAX_SURFACE_SIDE / size)));
}

function renderChunk(bitmap: ChunkBitmap, tiles: readonly number[], size: number, table: GidTable): void {
  const ctx = bitmap.context;
  if (!ctx) return;
  const { cell, columns, rows } = bitmap;
  const side = bitmap.surface.height;
  ctx.clearRect(0, 0, bitmap.surface.width, side);
  ctx.imageSmoothingEnabled = false;
  for (let ly = 0; ly < rows; ly++) {
    for (let lx = 0; lx < columns; lx++) {
      const gid = tiles[ly * size + lx] ?? 0;
      if (gid <= 0) continue;
      const draw = table.get(gid);
      const x = lx * cell;
      const y = side - (ly + 1) * cell;
      if (draw.image) {
        ctx.drawImage(draw.image, draw.sx, draw.sy, draw.sw, draw.sh, x, y, cell, cell);
      } else {
        ctx.fillStyle = draw.color;
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
}

function drawPreview(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame): void {
  const preview = frame.preview!;
  const { tilemap, cellSize, pan, cssHeight } = frame;
  // Only the part inside the map paints.
  const minX = Math.max(0, preview.minX);
  const minY = Math.max(0, preview.minY);
  const maxX = Math.min(tilemap.width - 1, preview.maxX);
  const maxY = Math.min(tilemap.height - 1, preview.maxY);
  if (maxX < minX || maxY < minY) return;
  const left = minX * cellSize + pan.x;
  const top = cssHeight - (maxY + 1) * cellSize - pan.y;
  const width = (maxX - minX + 1) * cellSize;
  const height = (maxY - minY + 1) * cellSize;
  ctx.fillStyle = "oklch(0.75 0.17 60 / 0.25)";
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = "oklch(0.75 0.17 60)";
  ctx.lineWidth = 2;
  ctx.strokeRect(left + 1, top + 1, width - 2, height - 2);
}

function drawGrid(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame): void {
  const { cssWidth, cssHeight, tilemap, pan, cellSize } = frame;
  const mapW = Math.max(1, tilemap.width);
  const mapH = Math.max(1, tilemap.height);
  const mapLeft = pan.x;
  const mapBottom = cssHeight - pan.y;
  const mapPixelW = mapW * cellSize;
  const mapPixelH = mapH * cellSize;
  const mapTop = mapBottom - mapPixelH;
  const mapRight = mapLeft + mapPixelW;
  // Only grid lines inside the viewport are submitted, each set as one path,
  // so a large map costs no more to redraw than the visible part of it.
  const firstColumn = Math.max(0, Math.floor(-mapLeft / cellSize));
  const lastColumn = Math.min(mapW, Math.ceil((cssWidth - mapLeft) / cellSize));
  const firstRow = Math.max(0, Math.floor((mapBottom - cssHeight) / cellSize));
  const lastRow = Math.min(mapH, Math.ceil(mapBottom / cellSize));
  const lineTop = Math.max(mapTop, 0);
  const lineBottom = Math.min(mapBottom, cssHeight);
  const lineLeft = Math.max(mapLeft, 0);
  const lineRight = Math.min(mapRight, cssWidth);
  ctx.save();
  ctx.beginPath();
  ctx.rect(mapLeft, mapTop, mapPixelW, mapPixelH);
  ctx.clip();
  ctx.strokeStyle = "oklch(0.4 0 0 / 0.4)";
  ctx.lineWidth = 1;
  if (firstColumn <= lastColumn) {
    ctx.beginPath();
    for (let gx = firstColumn; gx <= lastColumn; gx++) {
      const x = mapLeft + gx * cellSize;
      ctx.moveTo(x, lineTop);
      ctx.lineTo(x, lineBottom);
    }
    ctx.stroke();
  }
  if (firstRow <= lastRow) {
    ctx.beginPath();
    for (let gy = firstRow; gy <= lastRow; gy++) {
      const y = mapBottom - gy * cellSize;
      ctx.moveTo(lineLeft, y);
      ctx.lineTo(lineRight, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "oklch(0.92 0 0)";
  ctx.lineWidth = 2;
  ctx.strokeRect(mapLeft + 0.5, mapTop + 0.5, mapPixelW, mapPixelH);
}

/** A bitmap for the browser: an `OffscreenCanvas` where there is one, else a detached canvas element. */
export function createBrowserPaintSurface(width: number, height: number): PaintSurface {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
