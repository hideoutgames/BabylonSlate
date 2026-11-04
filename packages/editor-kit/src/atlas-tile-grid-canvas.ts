import {
  tilesetAtlasColumns,
  tilesetAtlasRows,
  tilesetTileById,
  type TilesetPayload,
} from "@haptic/assets";

/** A host mark drawn on a tile: a dot in its corner, or the tile dimmed. */
export type AtlasTileMark = "dot" | "dim";

/** Atlas-pixel to surface-pixel mapping: `surface = offset + atlas * scale`. */
export interface AtlasGridView {
  scale: number;
  x: number;
  y: number;
}

/** The tile grid's columns and rows and the pixel stride between cells. */
function gridOf(tileset: TilesetPayload) {
  return {
    columns: tilesetAtlasColumns(tileset),
    rows: tilesetAtlasRows(tileset),
    strideX: tileset.tileWidth + tileset.spacing,
    strideY: tileset.tileHeight + tileset.spacing,
  };
}

/** Column and row of a 1-based tile id, or `null` outside the atlas grid. */
export function atlasTileCell(tileset: TilesetPayload, tileId: number): { column: number; row: number } | null {
  const { columns, rows } = gridOf(tileset);
  if (!Number.isInteger(tileId) || tileId < 1 || tileId > columns * rows) return null;
  return { column: (tileId - 1) % columns, row: Math.floor((tileId - 1) / columns) };
}

/** The 1-based id of the tile at `column`, `row`, or 0 outside the grid. */
export function atlasTileAt(tileset: TilesetPayload, column: number, row: number): number {
  const { columns, rows } = gridOf(tileset);
  if (column < 0 || row < 0 || column >= columns || row >= rows) return 0;
  return row * columns + column + 1;
}

/**
 * Tiles whose cell touches the atlas-pixel rectangle, in reading order, found
 * from the column and row range it spans rather than by testing every tile.
 */
export function atlasTilesInRect(
  tileset: TilesetPayload,
  rect: { x: number; y: number; right: number; bottom: number },
): number[] {
  const { columns, rows, strideX, strideY } = gridOf(tileset);
  if (strideX <= 0 || strideY <= 0) return [];
  const { margin, tileWidth, tileHeight } = tileset;
  const firstColumn = Math.max(0, Math.ceil((rect.x - margin - tileWidth) / strideX));
  const lastColumn = Math.min(columns - 1, Math.floor((rect.right - margin) / strideX));
  const firstRow = Math.max(0, Math.ceil((rect.y - margin - tileHeight) / strideY));
  const lastRow = Math.min(rows - 1, Math.floor((rect.bottom - margin) / strideY));
  const ids: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) ids.push(row * columns + column + 1);
  }
  return ids;
}

/** Tile ids of the cells at least partly on a `width` × `height` surface, in reading order. */
export function visibleAtlasTiles(tileset: TilesetPayload, view: AtlasGridView, width: number, height: number): number[] {
  if (view.scale <= 0 || width <= 0 || height <= 0) return [];
  return atlasTilesInRect(tileset, {
    x: -view.x / view.scale,
    y: -view.y / view.scale,
    right: (width - view.x) / view.scale,
    bottom: (height - view.y) / view.scale,
  });
}

/** Theme colours the grid draws with, read from CSS custom properties on every draw. */
export interface AtlasGridColors {
  foreground: string;
  background: string;
  primary: string;
  selected: string;
}

export interface AtlasGridDrawInput {
  tileset: TilesetPayload;
  view: AtlasGridView;
  /** Surface size in CSS pixels, and the device pixel ratio the canvas is sized for. */
  width: number;
  height: number;
  dpr: number;
  selected: ReadonlySet<number>;
  marks?: ReadonlyMap<number, AtlasTileMark>;
  /** The tile under a hovering mouse, or 0. */
  hover: number;
  colors: AtlasGridColors;
  /** The diagonal hatch of Full collision tiles, in atlas pixels; omitted where patterns are unavailable. */
  hatch?: CanvasPattern | null;
}

type GridContext = Pick<
  CanvasRenderingContext2D,
  | "setTransform" | "clearRect" | "fillRect" | "strokeRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill"
  | "save" | "restore" | "rect" | "clip"
> & { fillStyle: CanvasRenderingContext2D["fillStyle"]; strokeStyle: CanvasRenderingContext2D["strokeStyle"]; lineWidth: number; globalAlpha: number };

/**
 * Draw the grid over the atlas image: collision (Full hatch, Chain polyline),
 * host marks, the hovered tile, every cell's 1 px border and the 2 px
 * selection ring, for the visible cells only. Lines keep their screen width at
 * any zoom. Returns how many cells were drawn.
 */
export function drawAtlasTileGrid(ctx: GridContext, input: AtlasGridDrawInput): number {
  const { tileset, view, width, height, dpr, selected, marks, hover, colors } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const cells = visibleAtlasTiles(tileset, view, width, height);
  const { strideX, strideY, columns } = gridOf(tileset);
  const cellWidth = tileset.tileWidth * view.scale;
  const cellHeight = tileset.tileHeight * view.scale;
  const left = (id: number) => view.x + (tileset.margin + ((id - 1) % columns) * strideX) * view.scale;
  const top = (id: number) => view.y + (tileset.margin + Math.floor((id - 1) / columns) * strideY) * view.scale;

  for (const id of cells) {
    const tile = tilesetTileById(tileset, id);
    if (tile?.collision === "full") {
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = colors.primary;
      ctx.fillRect(left(id), top(id), cellWidth, cellHeight);
      ctx.globalAlpha = 1;
      if (input.hatch) {
        ctx.fillStyle = input.hatch;
        ctx.fillRect(left(id), top(id), cellWidth, cellHeight);
      }
    }
  }
  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.06);
  for (const id of cells) {
    const collision = tilesetTileById(tileset, id)?.collision;
    if (!collision || typeof collision !== "object" || collision.points.length < 2) continue;
    ctx.beginPath();
    collision.points.forEach((point, at) => {
      const x = left(id) + point.x * cellWidth;
      const y = top(id) + (1 - point.y) * cellHeight;
      if (at === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  if (marks && marks.size > 0) {
    for (const id of cells) {
      const mark = marks.get(id);
      if (mark === "dim") {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = colors.background;
        ctx.fillRect(left(id), top(id), cellWidth, cellHeight);
        ctx.globalAlpha = 1;
      } else if (mark === "dot") {
        const radius = Math.min(cellWidth, cellHeight) * 0.09;
        ctx.beginPath();
        ctx.arc(left(id) + cellWidth * 0.16, top(id) + cellHeight * 0.84, radius + 1, 0, Math.PI * 2);
        ctx.fillStyle = colors.background;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(left(id) + cellWidth * 0.16, top(id) + cellHeight * 0.84, radius, 0, Math.PI * 2);
        ctx.fillStyle = colors.selected;
        ctx.fill();
      }
    }
  }
  if (hover > 0 && cells.includes(hover)) {
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = colors.foreground;
    ctx.fillRect(left(hover), top(hover), cellWidth, cellHeight);
    ctx.globalAlpha = 1;
  }
  // One path for every border, 1 screen pixel inside each cell.
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = colors.foreground;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const id of cells) {
    if (selected.has(id)) continue;
    ctx.rect(left(id) + 0.5, top(id) + 0.5, Math.max(0, cellWidth - 1), Math.max(0, cellHeight - 1));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const id of cells) {
    if (!selected.has(id)) continue;
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.background;
    ctx.strokeRect(left(id) - 0.5, top(id) - 0.5, cellWidth + 1, cellHeight + 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.selected;
    ctx.strokeRect(left(id) + 1, top(id) + 1, Math.max(0, cellWidth - 2), Math.max(0, cellHeight - 2));
  }
  return cells.length;
}
