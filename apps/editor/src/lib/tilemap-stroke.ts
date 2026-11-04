import {
  applyTilemapPaint,
  cellsAlongSegment,
  TilemapChunkIndex,
  tilemapCellKey,
  type TileCell,
  type TilemapPaintStroke,
  type TilemapPayload,
  type TilemapTerrainBrush,
  type TilesetPayload,
} from "@haptic/assets";

/** The cells a shape stroke covers, inclusive. */
export interface TilemapStrokeShape {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TilemapStrokeOptions {
  tool: TilemapPaintStroke["tool"];
  layerId: string;
  /** The tile painted; ignored by a terrain stroke. */
  gid: number;
  terrain?: TilemapTerrainBrush;
  tilesets: ReadonlyMap<string, TilesetPayload>;
  start: TileCell;
}

/**
 * One pointer gesture of a paint tool, from the map it started on.
 *
 * - Brush and Eraser queue the cells the pointer crosses (each once) and write
 *   them in one `flush`, so moves that arrive between two frames cost one edit
 *   of the map; a move that stays in its cell queues nothing.
 * - Rect only follows its corner: until `finish` it writes nothing and shows
 *   `shape`, then paints the whole rectangle (or resolves it as terrain) once.
 * - Bucket and Stamp paint when the stroke starts and ignore moves.
 *
 * `painted` is the map with the stroke so far; `finish` returns the map to commit.
 */
export class TilemapStroke {
  readonly base: TilemapPayload;
  painted: TilemapPayload;
  readonly options: TilemapStrokeOptions;
  private last: TileCell;
  private end: TileCell;
  private pending: TileCell[] = [];
  private readonly seen = new Set<number>();
  /** Chunk lookups reused across flushes that add to `painted`. */
  private readonly paintedChunks = new TilemapChunkIndex(true);
  private readonly baseChunks = new TilemapChunkIndex();

  constructor(base: TilemapPayload, options: TilemapStrokeOptions) {
    this.base = base;
    this.painted = base;
    this.options = options;
    this.last = options.start;
    this.end = options.start;
    const { tool, start } = options;
    if (tool === "brush" || tool === "eraser") this.queue([start]);
    else if (tool === "bucket" || tool === "stamp") {
      this.painted = this.paint(base, {
        cells: [start],
        stamp: tool === "stamp" ? { width: 2, height: 2, tiles: [options.gid, options.gid, options.gid, options.gid] } : undefined,
      }, this.baseChunks);
    }
  }

  /** The rectangle a Rect stroke will paint, while it is dragged; `null` for other tools. */
  get shape(): TilemapStrokeShape | null {
    if (this.options.tool !== "rect") return null;
    const { start } = this.options;
    return {
      minX: Math.min(start.x, this.end.x),
      minY: Math.min(start.y, this.end.y),
      maxX: Math.max(start.x, this.end.x),
      maxY: Math.max(start.y, this.end.y),
    };
  }

  /** Whether cells are queued for the next `flush`. */
  get queued(): boolean {
    return this.pending.length > 0;
  }

  /** Follow the pointer into `cell`; true when the stroke has something new to show. */
  moveTo(cell: TileCell): boolean {
    const { tool } = this.options;
    if (cell.x === this.last.x && cell.y === this.last.y) return false;
    if (tool === "brush" || tool === "eraser") {
      const before = this.pending.length;
      this.queue(cellsAlongSegment(this.last, cell));
      this.last = cell;
      return this.pending.length > before;
    }
    this.last = cell;
    if (tool !== "rect") return false;
    this.end = cell;
    return true;
  }

  /** Write the queued Brush or Eraser cells into `painted` and return it. */
  flush(): TilemapPayload {
    if (this.pending.length === 0) return this.painted;
    const cells = this.pending;
    this.pending = [];
    this.painted = this.paint(this.painted, { cells }, this.paintedChunks);
    return this.painted;
  }

  /** The map the whole stroke makes: queued cells written, a Rect painted in full. */
  finish(): TilemapPayload {
    this.flush();
    if (this.options.tool === "rect") {
      this.painted = this.paint(this.base, { end: this.end }, this.baseChunks);
    }
    return this.painted;
  }

  private queue(cells: Iterable<TileCell>): void {
    for (const cell of cells) {
      const key = tilemapCellKey(cell.x, cell.y);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pending.push(cell);
    }
  }

  private paint(
    from: TilemapPayload,
    stroke: Partial<Pick<TilemapPaintStroke, "cells" | "end" | "stamp">>,
    index: TilemapChunkIndex,
  ): TilemapPayload {
    const { tool, layerId, gid, terrain, tilesets, start } = this.options;
    return applyTilemapPaint(from, {
      tool,
      layerId,
      tileId: gid,
      start,
      end: stroke.end ?? start,
      cells: stroke.cells,
      stamp: stroke.stamp,
      terrain,
    }, index, tilesets);
  }
}
