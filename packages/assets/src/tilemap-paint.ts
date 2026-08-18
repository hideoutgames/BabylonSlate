import { getTile, setTile, type TilemapPayload } from "./tilemap-payload";

export const MIN_PAINT_CELL_SIZE = 8;
export const MAX_PAINT_CELL_SIZE = 96;
export const DEFAULT_PAINT_CELL_SIZE = 32;

export type TilemapPaintTool =
  | "move"
  | "brush"
  | "eraser"
  | "rect"
  | "bucket"
  | "stamp"
  | "picker";

export interface TileStamp {
  width: number;
  height: number;
  /** Row-major, (0,0) bottom-left of the stamp. */
  tiles: number[];
}

export interface TileCell {
  x: number;
  y: number;
}

export interface TilemapPaintStroke {
  tool: Exclude<TilemapPaintTool, "picker" | "move">;
  layerId: string;
  tileId: number;
  start: TileCell;
  end: TileCell;
  cells?: readonly TileCell[];
  stamp?: TileStamp;
}

export function isTilemapPaintStrokeTool(
  tool: TilemapPaintTool,
): tool is TilemapPaintStroke["tool"] {
  return tool !== "move" && tool !== "picker";
}

/** Convert a Y-down canvas point into a +Y-up tile cell. */
export function paintCanvasTileAt(options: {
  localX: number;
  localY: number;
  canvasHeight: number;
  panX: number;
  panY: number;
  cellSize: number;
}): TileCell {
  const size = options.cellSize > 0 ? options.cellSize : 16;
  return {
    x: Math.floor((options.localX - options.panX) / size),
    y: Math.floor(
      (options.canvasHeight - options.localY - options.panY) / size,
    ),
  };
}

export interface TilemapPaintView {
  panX: number;
  panY: number;
  cellSize: number;
}

function clampPaintCellSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PAINT_CELL_SIZE;
  return Math.min(MAX_PAINT_CELL_SIZE, Math.max(MIN_PAINT_CELL_SIZE, value));
}

function zoomPaintView(options: {
  panX: number;
  panY: number;
  cellSize: number;
  originX: number;
  originY: number;
  canvasHeight: number;
  nextCellSize: number;
  translationX?: number;
  translationY?: number;
}): TilemapPaintView {
  const cellSize = options.cellSize > 0 ? options.cellSize : DEFAULT_PAINT_CELL_SIZE;
  const nextCellSize = clampPaintCellSize(options.nextCellSize);
  const fracX = (options.originX - options.panX) / cellSize;
  const fracY =
    (options.canvasHeight - options.originY - options.panY) / cellSize;
  return {
    panX: options.originX - fracX * nextCellSize + (options.translationX ?? 0),
    panY:
      options.canvasHeight -
      options.originY -
      fracY * nextCellSize +
      (options.translationY ?? 0),
    cellSize: nextCellSize,
  };
}

/** Pinch: scale about the midpoint, then add two-finger translation. */
export function applyPinchView(options: {
  panX: number;
  panY: number;
  cellSize: number;
  originX: number;
  originY: number;
  canvasHeight: number;
  spreadRatio: number;
  translationX?: number;
  translationY?: number;
}): TilemapPaintView {
  const cellSize = options.cellSize > 0 ? options.cellSize : DEFAULT_PAINT_CELL_SIZE;
  const ratio = Number.isFinite(options.spreadRatio) ? options.spreadRatio : 1;
  return zoomPaintView({
    ...options,
    nextCellSize: cellSize * ratio,
  });
}

/** One-finger Move pan. `dx`/`dy` are already in pan space. */
export function applyPointerPan(options: {
  panX: number;
  panY: number;
  dx: number;
  dy: number;
}): { panX: number; panY: number } {
  return {
    panX: options.panX + options.dx,
    panY: options.panY + options.dy,
  };
}

/** Wheel: zoom about the cursor. Negative deltaY zooms in. */
export function applyWheelZoom(options: {
  panX: number;
  panY: number;
  cellSize: number;
  originX: number;
  originY: number;
  canvasHeight: number;
  deltaY: number;
}): TilemapPaintView {
  const cellSize = options.cellSize > 0 ? options.cellSize : DEFAULT_PAINT_CELL_SIZE;
  const steps = Number.isFinite(options.deltaY) ? -options.deltaY / 120 : 0;
  return zoomPaintView({
    ...options,
    nextCellSize: cellSize * 2 ** steps,
  });
}

/** Inclusive Bresenham segment in tile space. */
export function cellsAlongSegment(start: TileCell, end: TileCell): TileCell[] {
  const cells: TileCell[] = [];
  let x0 = start.x;
  let y0 = start.y;
  const x1 = end.x;
  const y1 = end.y;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return cells;
}

export function pickTileId(
  map: TilemapPayload,
  layerId: string,
  gx: number,
  gy: number,
): number {
  return getTile(map, layerId, gx, gy);
}

export function applyTilemapPaint(
  map: TilemapPayload,
  stroke: TilemapPaintStroke,
): TilemapPayload {
  switch (stroke.tool) {
    case "brush":
      return paintCells(
        map,
        stroke.layerId,
        stroke.cells ?? cellsAlongSegment(stroke.start, stroke.end),
        stroke.tileId,
      );
    case "eraser":
      return paintCells(
        map,
        stroke.layerId,
        stroke.cells ?? cellsAlongSegment(stroke.start, stroke.end),
        0,
      );
    case "rect":
      return paintCells(
        map,
        stroke.layerId,
        rectCells(stroke.start, stroke.end),
        stroke.tileId,
      );
    case "bucket":
      return floodFill(map, stroke.layerId, stroke.start, stroke.tileId);
    case "stamp":
      return stampTiles(map, stroke.layerId, stroke.start, stroke.stamp);
  }
}

function paintCells(
  map: TilemapPayload,
  layerId: string,
  cells: readonly TileCell[],
  tileId: number,
): TilemapPayload {
  let next = map;
  for (const cell of cells) {
    next = setTile(next, layerId, cell.x, cell.y, tileId);
  }
  return next;
}

function rectCells(start: TileCell, end: TileCell): TileCell[] {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const cells: TileCell[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      cells.push({ x, y });
    }
  }
  return cells;
}

function stampTiles(
  map: TilemapPayload,
  layerId: string,
  origin: TileCell,
  stamp: TileStamp | undefined,
): TilemapPayload {
  if (!stamp || stamp.width < 1 || stamp.height < 1) return map;
  let next = map;
  for (let ly = 0; ly < stamp.height; ly++) {
    for (let lx = 0; lx < stamp.width; lx++) {
      const id = stamp.tiles[ly * stamp.width + lx] ?? 0;
      next = setTile(next, layerId, origin.x + lx, origin.y + ly, id);
    }
  }
  return next;
}

function floodFill(
  map: TilemapPayload,
  layerId: string,
  start: TileCell,
  tileId: number,
): TilemapPayload {
  const source = getTile(map, layerId, start.x, start.y);
  if (source === tileId) return map;
  const bounds = fillBounds(map, layerId, start);
  const seen = new Set<string>();
  const queue: TileCell[] = [start];
  const cells: TileCell[] = [];
  while (queue.length > 0) {
    const cell = queue.pop()!;
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      cell.x < bounds.minX ||
      cell.x > bounds.maxX ||
      cell.y < bounds.minY ||
      cell.y > bounds.maxY
    ) {
      continue;
    }
    if (getTile(map, layerId, cell.x, cell.y) !== source) continue;
    cells.push(cell);
    queue.push(
      { x: cell.x + 1, y: cell.y },
      { x: cell.x - 1, y: cell.y },
      { x: cell.x, y: cell.y + 1 },
      { x: cell.x, y: cell.y - 1 },
    );
  }
  return paintCells(map, layerId, cells, tileId);
}

function fillBounds(
  map: TilemapPayload,
  layerId: string,
  start: TileCell,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const layer = map.layers.find((entry) => entry.id === layerId);
  const size = Math.max(1, map.chunkSize);
  let minX = start.x;
  let maxX = start.x;
  let minY = start.y;
  let maxY = start.y;
  for (const chunk of layer?.chunks ?? []) {
    minX = Math.min(minX, chunk.cx * size);
    maxX = Math.max(maxX, chunk.cx * size + size - 1);
    minY = Math.min(minY, chunk.cy * size);
    maxY = Math.max(maxY, chunk.cy * size + size - 1);
  }
  return { minX, maxX, minY, maxY };
}

/** Stroke merge key so one undo restores the whole pointer gesture. */
export function tilemapStrokeMergeKey(strokeId: string): string {
  return `tilemap-stroke:${strokeId}`;
}
