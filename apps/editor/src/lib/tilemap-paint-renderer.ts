import {
  decodeTileGid,
  offsetTilemapCellRect,
  orderedTilemapLayers,
  paintCanvasPoint,
  tilePlaceholderHsl,
  tilemapCellBounds,
  tilemapCellKey,
  tilesetTileRect,
  type TilemapCellRect,
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
  /** An unbounded map's pivot (tile units) to mark over everything, while a drag moves it. */
  pivot?: { x: number; y: number } | null;
  /** Tiles lifted off the map (a selection dragged, a paste waiting to be placed), drawn where they will land. */
  float?: TilemapPaintFloat | null;
  /** The selected cells, outlined with dashes above the tiles and the grid. */
  selection?: TilemapCellRect | null;
}

/**
 * Tiles drawn away from their cells without editing the map: per layer, the
 * chunks that hold them (in their own cells), the cells of those chunks that
 * float and where they show. A move floats the map's own chunks, so it
 * composites the bitmaps the map already has at an offset and redraws no
 * tile; a paste floats chunks the map does not hold (`detached`), which get
 * bitmaps of their own while it shows.
 */
export interface TilemapPaintFloat {
  layers: ReadonlyMap<string, readonly TilemapChunk[]>;
  /** The floating cells, in the chunks' cells. */
  rect: TilemapCellRect;
  /** Whole cells from the chunks' cells to the map's. */
  offset: { x: number; y: number };
  /** Map cells drawn empty on the floating layers: where a moved block was lifted from. */
  hole: TilemapCellRect | null;
  detached: boolean;
}

/**
 * What a frame cost: chunk bitmaps composited, chunk bitmaps (re)drawn tile by
 * tile, and tiles drawn straight from their atlas (a zoom past the bitmaps' resolution).
 */
export interface TilemapPaintStats {
  composited: number;
  rendered: number;
  direct: number;
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
 *
 * A bitmap holds at most `MAX_CELL_PIXELS` per cell. When the Tilesets' tiles
 * have more pixels than that and a cell on screen needs more device pixels than
 * its bitmap holds, the frame draws the cells in view straight from their atlas
 * instead, as large as they show, so Paint is never coarser than the atlas.
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
    const stats: TilemapPaintStats = { composited: 0, rendered: 0, direct: 0 };
    this.frame += 1;
    const table = this.tableFor(tilemap.tilesets, frame.payloads, frame.atlases);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "oklch(0.2 0 0)";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.imageSmoothingEnabled = false;
    const size = Math.max(1, tilemap.chunkSize);
    const chunkPixels = size * cellSize;
    const { cell, source } = cellPixels(tilemap, frame.payloads, size);
    // A bitmap smaller than the tiles would show them coarser than the atlas once a cell needs more pixels.
    const direct = cell < source && cellSize * dpr > cell;
    const float = frame.float ?? null;
    /** Draw one chunk with its bottom-left cell `x`, `y` cells from the map's origin. */
    const drawChunk = (layerKey: string, chunk: TilemapChunk, part: ChunkPart | null, x: number, y: number) => {
      const left = x * cellSize + pan.x;
      const bottom = cssHeight - y * cellSize - pan.y;
      if (!part || left + chunkPixels < 0 || left > cssWidth || bottom < 0 || bottom - chunkPixels > cssHeight) return;
      if (direct) {
        stats.direct += drawCellsInView(ctx, chunk, part, size, table, { left, bottom, cellSize, cssWidth, cssHeight });
        return;
      }
      const bitmap = this.bitmapFor(layerKey, chunk, part, size, cell, table, stats);
      // The bitmap holds the chunk's in-map columns and rows, from its bottom-left.
      const width = bitmap.columns * bitmap.cell;
      const height = bitmap.rows * bitmap.cell;
      ctx.drawImage(
        bitmap.surface,
        0, bitmap.surface.height - height, width, height,
        left, bottom - bitmap.rows * cellSize, bitmap.columns * cellSize, bitmap.rows * cellSize,
      );
      stats.composited += 1;
    };
    for (const layer of orderedTilemapLayers(tilemap, frame.sortingLayers)) {
      if (!layer.visible) continue;
      const floating = float?.layers.get(layer.id);
      // A lifted block leaves its cells empty on its layers; what lies under it on other layers still shows.
      const hole = floating && float!.hole ? cellsOnCanvas(frame, float!.hole) : null;
      if (hole) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cssWidth, cssHeight);
        ctx.rect(hole.left, hole.top, hole.width, hole.height);
        ctx.clip("evenodd");
      }
      for (const chunk of layer.chunks) {
        drawChunk(layer.id, chunk, chunkPartInMap(chunk, tilemap, size), chunk.cx * size, chunk.cy * size);
      }
      if (hole) ctx.restore();
      if (!floating) continue;
      // The floating tiles of this layer draw in its place among the layers, clipped to the block.
      const { rect, offset, detached } = float!;
      const dest = cellsOnCanvas(frame, offsetTilemapCellRect(rect, offset.x, offset.y));
      ctx.save();
      ctx.beginPath();
      ctx.rect(dest.left, dest.top, dest.width, dest.height);
      ctx.clip();
      for (const chunk of floating) {
        const x = chunk.cx * size;
        const y = chunk.cy * size;
        if (x > rect.maxX || x + size - 1 < rect.minX || y > rect.maxY || y + size - 1 < rect.minY) continue;
        drawChunk(
          detached ? `${DETACHED_LAYER}${layer.id}` : layer.id,
          chunk,
          detached ? WHOLE_CHUNK(size) : chunkPartInMap(chunk, tilemap, size),
          x + offset.x,
          y + offset.y,
        );
      }
      ctx.restore();
    }
    if (float) drawCutOff(ctx, frame, float);
    if (frame.preview) drawPreview(ctx, frame);
    drawGrid(ctx, frame);
    if (frame.selection) drawSelection(ctx, frame, frame.selection);
    if (tilemap.unbounded) drawPivotMarker(ctx, frame, frame.pivot ?? tilemap.pivot);
    this.dropDetached();
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

  /** Bitmaps of floating chunks the map does not hold, once the latest frame no longer shows them. */
  private dropDetached(): void {
    for (const [key, layer] of this.bitmaps) {
      if (!key.startsWith(DETACHED_LAYER)) continue;
      let shown = false;
      for (const bitmap of layer.values()) shown ||= bitmap.used === this.frame;
      if (shown) continue;
      for (const bitmap of layer.values()) this.bytes -= surfaceBytes(bitmap.surface);
      this.bitmaps.delete(key);
    }
  }

  private bitmapFor(
    layerKey: string,
    chunk: TilemapChunk,
    part: ChunkPart,
    size: number,
    cell: number,
    table: GidTable,
    stats: TilemapPaintStats,
  ): ChunkBitmap {
    const { columns, rows } = part;
    let layer = this.bitmaps.get(layerKey);
    if (!layer) this.bitmaps.set(layerKey, (layer = new Map()));
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

/** The columns and rows of a chunk a bitmap holds, from its bottom-left. */
interface ChunkPart {
  columns: number;
  rows: number;
}

/** Bitmap layer keys of floating chunks the map does not hold (a paste), apart from every map layer's. */
const DETACHED_LAYER = "\u0000float:";

const WHOLE_CHUNK = (size: number): ChunkPart => ({ columns: size, rows: size });

/**
 * The columns and rows of a chunk inside the map, from its bottom-left: all of
 * it on an unbounded map (negative chunks included), the part inside `width` ×
 * `height` on a bounded one, `null` when none of it is.
 */
function chunkPartInMap(chunk: TilemapChunk, tilemap: TilemapPayload, size: number): ChunkPart | null {
  if (tilemap.unbounded) return WHOLE_CHUNK(size);
  if (chunk.cx < 0 || chunk.cy < 0) return null;
  const columns = Math.min(size, tilemap.width - chunk.cx * size);
  const rows = Math.min(size, tilemap.height - chunk.cy * size);
  return columns > 0 && rows > 0 ? { columns, rows } : null;
}

/**
 * `source`: the largest tile side of the map's Tilesets (the map's tile size
 * while none is loaded). `cell`: bitmap pixels per cell, `source` within the
 * bitmap size limits.
 */
function cellPixels(tilemap: TilemapPayload, payloads: ReadonlyMap<string, TilesetPayload>, size: number): { cell: number; source: number } {
  let tile = 1;
  for (const ref of tilemap.tilesets) {
    const payload = payloads.get(ref.guid);
    if (payload) tile = Math.max(tile, payload.tileWidth, payload.tileHeight);
  }
  if (tile <= 1) tile = Math.max(tilemap.tileWidth, tilemap.tileHeight);
  return { source: tile, cell: Math.max(1, Math.min(tile, MAX_CELL_PIXELS, Math.floor(MAX_SURFACE_SIDE / size))) };
}

/**
 * Draw a chunk's cells that are in view straight from their atlas (or their
 * placeholder colour), each `cellSize` across, as the bitmaps would place
 * them. Returns how many tiles it drew.
 */
function drawCellsInView(
  ctx: CanvasRenderingContext2D,
  chunk: TilemapChunk,
  part: ChunkPart,
  size: number,
  table: GidTable,
  view: { left: number; bottom: number; cellSize: number; cssWidth: number; cssHeight: number },
): number {
  const { left, bottom, cellSize, cssWidth, cssHeight } = view;
  // Only the chunk's columns and rows inside the map, and of those only the ones on the canvas.
  const { columns, rows } = part;
  const firstColumn = Math.max(0, Math.floor(-left / cellSize));
  const lastColumn = Math.min(columns - 1, Math.floor((cssWidth - left) / cellSize));
  const firstRow = Math.max(0, Math.floor((bottom - cssHeight) / cellSize));
  const lastRow = Math.min(rows - 1, Math.ceil(bottom / cellSize) - 1);
  let drawn = 0;
  for (let ly = firstRow; ly <= lastRow; ly++) {
    for (let lx = firstColumn; lx <= lastColumn; lx++) {
      const gid = chunk.tiles[ly * size + lx] ?? 0;
      if (gid <= 0) continue;
      const draw = table.get(gid);
      const x = left + lx * cellSize;
      const y = bottom - (ly + 1) * cellSize;
      if (draw.image) {
        ctx.drawImage(draw.image, draw.sx, draw.sy, draw.sw, draw.sh, x, y, cellSize, cellSize);
      } else {
        ctx.fillStyle = draw.color;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
      drawn += 1;
    }
  }
  return drawn;
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
  // Only the part inside a bounded map paints; an unbounded map paints it all.
  const bounded = !tilemap.unbounded;
  const minX = bounded ? Math.max(0, preview.minX) : preview.minX;
  const minY = bounded ? Math.max(0, preview.minY) : preview.minY;
  const maxX = bounded ? Math.min(tilemap.width - 1, preview.maxX) : preview.maxX;
  const maxY = bounded ? Math.min(tilemap.height - 1, preview.maxY) : preview.maxY;
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

/** A cell rect's canvas rectangle, in CSS pixels from the canvas's top-left. */
function cellsOnCanvas(frame: TilemapPaintFrame, rect: TilemapCellRect): { left: number; top: number; width: number; height: number } {
  const { cellSize, pan, cssHeight } = frame;
  return {
    left: rect.minX * cellSize + pan.x,
    top: cssHeight - (rect.maxY + 1) * cellSize - pan.y,
    width: (rect.maxX - rect.minX + 1) * cellSize,
    height: (rect.maxY - rect.minY + 1) * cellSize,
  };
}

/** The selection outline's colour: the editor's `--selection` orange, as the viewport outline. */
export const SELECTION_STROKE = "#ff8000";
/** Over floating cells past the map's edge, which placing them cuts off: the canvas dimmed, then the dark theme's `--destructive`. */
const CUT_OFF_DIM = "oklch(0.2 0 0 / 0.55)";
export const CUT_OFF_FILL = "oklch(0.704 0.191 22.216 / 0.4)";

/**
 * Dim and tint the floating block's cells that lie past the map's edge (a
 * bounded map's size, an unbounded map's cell limit): placing it there cuts them off.
 */
function drawCutOff(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame, float: TilemapPaintFloat): void {
  const dest = offsetTilemapCellRect(float.rect, float.offset.x, float.offset.y);
  const box = tilemapCellBounds(frame.tilemap);
  const inMinX = Math.max(dest.minX, box.minX);
  const inMaxX = Math.min(dest.maxX, box.maxX);
  const strips: TilemapCellRect[] = [];
  if (dest.minX < box.minX) strips.push({ ...dest, maxX: Math.min(dest.maxX, box.minX - 1) });
  if (dest.maxX > box.maxX) strips.push({ ...dest, minX: Math.max(dest.minX, box.maxX + 1) });
  if (inMinX <= inMaxX) {
    if (dest.minY < box.minY) strips.push({ minX: inMinX, maxX: inMaxX, minY: dest.minY, maxY: Math.min(dest.maxY, box.minY - 1) });
    if (dest.maxY > box.maxY) strips.push({ minX: inMinX, maxX: inMaxX, minY: Math.max(dest.minY, box.maxY + 1), maxY: dest.maxY });
  }
  for (const strip of strips) {
    const { left, top, width, height } = cellsOnCanvas(frame, strip);
    ctx.fillStyle = CUT_OFF_DIM;
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = CUT_OFF_FILL;
    ctx.fillRect(left, top, width, height);
  }
}

/** The selected cells: orange dashes over a dark halo, so the outline reads on any tile. */
function drawSelection(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame, rect: TilemapCellRect): void {
  const { left, top, width, height } = cellsOnCanvas(frame, rect);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "oklch(0.15 0 0 / 0.85)";
  ctx.setLineDash([]);
  ctx.strokeRect(left + 1, top + 1, width - 2, height - 2);
  ctx.strokeStyle = SELECTION_STROKE;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(left + 1, top + 1, width - 2, height - 2);
  ctx.setLineDash([]);
}

const GRID_STROKE = "oklch(0.4 0 0 / 0.4)";

function drawGrid(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame): void {
  const { cssWidth, cssHeight, tilemap, pan, cellSize } = frame;
  if (tilemap.unbounded) {
    drawEndlessGrid(ctx, frame);
    return;
  }
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
  ctx.strokeStyle = GRID_STROKE;
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

/** An unbounded map's grid: every cell line in view, with no map border or clip. */
function drawEndlessGrid(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame): void {
  const { cssWidth, cssHeight, pan, cellSize } = frame;
  const originBottom = cssHeight - pan.y;
  const firstColumn = Math.floor(-pan.x / cellSize);
  const lastColumn = Math.ceil((cssWidth - pan.x) / cellSize);
  const firstRow = Math.floor((originBottom - cssHeight) / cellSize);
  const lastRow = Math.ceil(originBottom / cellSize);
  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = firstColumn; gx <= lastColumn; gx++) {
    const x = pan.x + gx * cellSize;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let gy = firstRow; gy <= lastRow; gy++) {
    const y = originBottom - gy * cellSize;
    ctx.moveTo(0, y);
    ctx.lineTo(cssWidth, y);
  }
  ctx.stroke();
}

/** Half the length of the pivot marker's arms, in CSS pixels. */
export const PIVOT_MARKER_ARM = 12;
/** The pivot marker's colour: apart from the grey grid and the orange shape outline. */
export const PIVOT_MARKER_STROKE = "oklch(0.78 0.15 210)";

/**
 * The pivot of an unbounded map, over the tiles, the grid and any shape
 * outline: a crosshair with a ring, drawn on a dark halo so it reads on any tile.
 */
function drawPivotMarker(ctx: CanvasRenderingContext2D, frame: TilemapPaintFrame, pivot: { x: number; y: number }): void {
  const point = paintCanvasPoint({ x: pivot.x, y: pivot.y, canvasHeight: frame.cssHeight, panX: frame.pan.x, panY: frame.pan.y, cellSize: frame.cellSize });
  const arm = PIVOT_MARKER_ARM;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(point.x - arm, point.y);
    ctx.lineTo(point.x + arm, point.y);
    ctx.moveTo(point.x, point.y - arm);
    ctx.lineTo(point.x, point.y + arm);
    ctx.stroke();
    ctx.strokeRect(point.x - arm / 2, point.y - arm / 2, arm, arm);
  };
  ctx.strokeStyle = "oklch(0.15 0 0 / 0.85)";
  ctx.lineWidth = 4;
  path();
  ctx.strokeStyle = PIVOT_MARKER_STROKE;
  ctx.lineWidth = 2;
  path();
}

/** A bitmap for the browser: an `OffscreenCanvas` where there is one, else a detached canvas element. */
export function createBrowserPaintSurface(width: number, height: number): PaintSurface {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
