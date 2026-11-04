import { describe, expect, it } from "vitest";
import { createDefaultTilemapPayload, getTile, setTile, type TilemapPayload } from "./tilemap-payload";
import {
  applyPinchView,
  applyPointerPan,
  applyTilemapPaint,
  applyWheelZoom,
  cellsAlongSegment,
  isTilemapPaintStrokeTool,
  MAX_PAINT_CELL_SIZE,
  MIN_PAINT_CELL_SIZE,
  paintCanvasPivotAt,
  paintCanvasPoint,
  paintCanvasTileAt,
  pickTileId,
  tilemapBucketBounds,
  tilemapStrokeMergeKey,
} from "./tilemap-paint";

function mapWithTiles(
  cells: Array<[number, number, number]>,
  chunkSize = 4,
) {
  let map = {
    ...createDefaultTilemapPayload(),
    chunkSize,
  };
  for (const [x, y, id] of cells) {
    map = setTile(map, "layer-1", x, y, id);
  }
  return map;
}

describe("paintCanvasTileAt", () => {
  it("maps canvas Y-down coordinates onto +Y-up tile cells", () => {
    expect(
      paintCanvasTileAt({
        localX: 8,
        localY: 248,
        canvasHeight: 256,
        panX: 0,
        panY: 0,
        cellSize: 16,
      }),
    ).toEqual({ x: 0, y: 0 });
    expect(
      paintCanvasTileAt({
        localX: 24,
        localY: 8,
        canvasHeight: 256,
        panX: 0,
        panY: 0,
        cellSize: 16,
      }),
    ).toEqual({ x: 1, y: 15 });
  });

  it("scales the cell mapping when the painter zooms", () => {
    expect(
      paintCanvasTileAt({
        localX: 48,
        localY: 208,
        canvasHeight: 256,
        panX: 0,
        panY: 0,
        cellSize: 32,
      }),
    ).toEqual({ x: 1, y: 1 });
  });
});

describe("paintCanvasPoint and paintCanvasPivotAt", () => {
  const view = { canvasHeight: 256, panX: 100, panY: 40, cellSize: 20 };

  it("places a map point on the canvas and reads it back on half cells", () => {
    // Map point (-1.5, 2): 30 px left of the pan origin, 40 px above it.
    expect(paintCanvasPoint({ ...view, x: -1.5, y: 2 })).toEqual({ x: 70, y: 256 - 40 - 40 });
    expect(paintCanvasPivotAt({ ...view, localX: 70, localY: 176 })).toEqual({ x: -1.5, y: 2 });
    // A point between half cells goes to the nearest one.
    expect(paintCanvasPivotAt({ ...view, localX: 104, localY: 256 - 40 - 13 })).toEqual({ x: 0, y: 0.5 });
  });
});

describe("applyPinchView", () => {
  it("keeps the tile under the pinch midpoint while scaling and then pans", () => {
    const before = paintCanvasTileAt({
      localX: 32,
      localY: 32,
      canvasHeight: 256,
      panX: 0,
      panY: 0,
      cellSize: 16,
    });
    const zoomed = applyPinchView({
      panX: 0,
      panY: 0,
      cellSize: 16,
      originX: 32,
      originY: 32,
      canvasHeight: 256,
      spreadRatio: 2,
    });
    expect(zoomed.cellSize).toBe(32);
    expect(
      paintCanvasTileAt({
        localX: 32,
        localY: 32,
        canvasHeight: 256,
        panX: zoomed.panX,
        panY: zoomed.panY,
        cellSize: zoomed.cellSize,
      }),
    ).toEqual(before);
    const panned = applyPinchView({
      ...zoomed,
      originX: 32,
      originY: 32,
      canvasHeight: 256,
      spreadRatio: 1,
      translationX: 10,
      translationY: -4,
    });
    expect(panned.panX).toBe(zoomed.panX + 10);
    expect(panned.panY).toBe(zoomed.panY - 4);
  });

  it("clamps cell size", () => {
    expect(
      applyPinchView({
        panX: 0,
        panY: 0,
        cellSize: MIN_PAINT_CELL_SIZE,
        originX: 0,
        originY: 0,
        canvasHeight: 256,
        spreadRatio: 0.1,
      }).cellSize,
    ).toBe(MIN_PAINT_CELL_SIZE);
    expect(
      applyPinchView({
        panX: 0,
        panY: 0,
        cellSize: MAX_PAINT_CELL_SIZE,
        originX: 0,
        originY: 0,
        canvasHeight: 256,
        spreadRatio: 8,
      }).cellSize,
    ).toBe(MAX_PAINT_CELL_SIZE);
  });
});

describe("applyPointerPan", () => {
  it("shifts pan by the pointer delta", () => {
    expect(applyPointerPan({ panX: 10, panY: 4, dx: 5, dy: -3 })).toEqual({
      panX: 15,
      panY: 1,
    });
  });
});

describe("isTilemapPaintStrokeTool", () => {
  it("does not treat move, select or picker as a paint stroke", () => {
    expect(isTilemapPaintStrokeTool("move")).toBe(false);
    expect(isTilemapPaintStrokeTool("select")).toBe(false);
    expect(isTilemapPaintStrokeTool("picker")).toBe(false);
    expect(isTilemapPaintStrokeTool("brush")).toBe(true);
  });
});

describe("applyWheelZoom", () => {
  it("zooms about the cursor and keeps the tile under it", () => {
    const before = paintCanvasTileAt({
      localX: 16,
      localY: 16,
      canvasHeight: 256,
      panX: 0,
      panY: 0,
      cellSize: 16,
    });
    const next = applyWheelZoom({
      panX: 0,
      panY: 0,
      cellSize: 16,
      originX: 16,
      originY: 16,
      canvasHeight: 256,
      deltaY: -120,
    });
    expect(next.cellSize).toBeGreaterThan(16);
    expect(
      paintCanvasTileAt({
        localX: 16,
        localY: 16,
        canvasHeight: 256,
        panX: next.panX,
        panY: next.panY,
        cellSize: next.cellSize,
      }),
    ).toEqual(before);
  });
});

describe("cellsAlongSegment", () => {
  it("includes both endpoints of a horizontal run", () => {
    expect(cellsAlongSegment({ x: 0, y: 1 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
  });
});

describe("applyTilemapPaint", () => {
  it("brushes listed cells with the selected tile", () => {
    const next = applyTilemapPaint(createDefaultTilemapPayload(), {
      tool: "brush",
      layerId: "layer-1",
      tileId: 1,
      start: { x: 0, y: 0 },
      end: { x: 2, y: 0 },
      cells: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    });
    expect(getTile(next, "layer-1", 0, 0)).toBe(1);
    expect(getTile(next, "layer-1", 1, 0)).toBe(1);
    expect(getTile(next, "layer-1", 2, 0)).toBe(1);
    expect(getTile(next, "layer-1", 3, 0)).toBe(0);
  });

  it("erases listed cells to empty", () => {
    const next = applyTilemapPaint(mapWithTiles([[0, 0, 1], [1, 0, 1]]), {
      tool: "eraser",
      layerId: "layer-1",
      tileId: 1,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      cells: [{ x: 0, y: 0 }],
    });
    expect(getTile(next, "layer-1", 0, 0)).toBe(0);
    expect(getTile(next, "layer-1", 1, 0)).toBe(1);
  });

  it("keeps storage sparse when erasing", () => {
    const map = mapWithTiles([[0, 0, 1]], 4);
    const erase = (cells: Array<{ x: number; y: number }>) => (from: typeof map) =>
      applyTilemapPaint(from, { tool: "eraser", layerId: "layer-1", tileId: 1, start: cells[0]!, end: cells[0]!, cells });
    // An empty cell in an unallocated chunk erases to the same map.
    expect(erase([{ x: 9, y: 9 }])(map)).toBe(map);
    // Erasing a chunk's last tile drops the chunk.
    expect(erase([{ x: 0, y: 0 }])(map).layers[0]!.chunks).toEqual([]);
  });

  it("fills an inclusive rectangle from start to end", () => {
    const next = applyTilemapPaint(createDefaultTilemapPayload(), {
      tool: "rect",
      layerId: "layer-1",
      tileId: 2,
      start: { x: 1, y: 1 },
      end: { x: 2, y: 3 },
    });
    expect(getTile(next, "layer-1", 1, 1)).toBe(2);
    expect(getTile(next, "layer-1", 2, 3)).toBe(2);
    expect(getTile(next, "layer-1", 1, 2)).toBe(2);
    expect(getTile(next, "layer-1", 0, 1)).toBe(0);
  });

  it("flood-fills 4-connected tiles of the same id", () => {
    const next = applyTilemapPaint(
      mapWithTiles([
        [0, 0, 1],
        [1, 0, 1],
        [2, 0, 3],
        [0, 1, 1],
      ]),
      {
        tool: "bucket",
        layerId: "layer-1",
        tileId: 9,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
      },
    );
    expect(getTile(next, "layer-1", 0, 0)).toBe(9);
    expect(getTile(next, "layer-1", 1, 0)).toBe(9);
    expect(getTile(next, "layer-1", 0, 1)).toBe(9);
    expect(getTile(next, "layer-1", 2, 0)).toBe(3);
  });

  it("fills the connected empty region up to the map edge, around painted tiles", () => {
    const bucket = (map: ReturnType<typeof mapWithTiles>, x: number, y: number) =>
      applyTilemapPaint(map, { tool: "bucket", layerId: "layer-1", tileId: 9, start: { x, y }, end: { x, y } });
    // A 6 × 4 map with a wall at x = 2 that leaves a gap at the top row.
    let map = { ...mapWithTiles([[2, 0, 5], [2, 1, 5], [2, 2, 5]], 4), width: 6, height: 4 };
    const filled = bucket(map, 0, 0);
    expect([0, 1, 3, 4, 5].map((x) => getTile(filled, "layer-1", x, 0))).toEqual([9, 9, 9, 9, 9]);
    expect(getTile(filled, "layer-1", 5, 3)).toBe(9);
    expect(getTile(filled, "layer-1", 2, 1)).toBe(5);
    expect(getTile(filled, "layer-1", 6, 0)).toBe(0);
    // Closing the gap keeps the fill on its own side.
    map = { ...mapWithTiles([[2, 0, 5], [2, 1, 5], [2, 2, 5], [2, 3, 5]], 4), width: 6, height: 4 };
    const left = bucket(map, 0, 0);
    expect(getTile(left, "layer-1", 1, 3)).toBe(9);
    expect(getTile(left, "layer-1", 3, 0)).toBe(0);
    // An empty layer fills the whole map; a start outside it changes nothing.
    const empty = { ...createDefaultTilemapPayload(), width: 3, height: 2 };
    const whole = bucket(empty, 1, 1);
    expect([0, 1, 2].flatMap((x) => [0, 1].map((y) => getTile(whole, "layer-1", x, y)))).toEqual([9, 9, 9, 9, 9, 9]);
    expect(bucket(empty, 5, 0)).toBe(empty);
  });

  it("fills an unbounded layer's empty cells up to 16 cells past its painted tiles and the start", () => {
    const bucket = (map: TilemapPayload, x: number, y: number) =>
      applyTilemapPaint(map, { tool: "bucket", layerId: "layer-1", tileId: 9, start: { x, y }, end: { x, y } });
    const painted = (map: TilemapPayload) => map.layers[0]!.chunks.flatMap((chunk) => chunk.tiles).filter((gid) => gid === 9).length;
    const open: TilemapPayload = { ...mapWithTiles([]), unbounded: true, pivot: { x: 0, y: 0 } };
    // An empty layer: the 33 × 33 box around the start cell, negative cells included.
    const alone = bucket(open, -2, 3);
    expect(painted(alone)).toBe(33 * 33);
    expect(tilemapBucketBounds(open, "layer-1", { x: -2, y: 3 })).toEqual({ minX: -18, minY: -13, maxX: 14, maxY: 19 });
    expect([getTile(alone, "layer-1", -18, -13), getTile(alone, "layer-1", 14, 19)]).toEqual([9, 9]);
    expect([getTile(alone, "layer-1", -19, 3), getTile(alone, "layer-1", -2, 20)]).toEqual([0, 0]);
    // A painted layer: its extent and the start, grown by the margin, around a painted wall.
    const walled = setTile(setTile(open, "layer-1", -10, 0, 5), "layer-1", 10, 5, 5);
    expect(tilemapBucketBounds(walled, "layer-1", { x: 0, y: 0 })).toEqual({ minX: -26, minY: -16, maxX: 26, maxY: 21 });
    const filled = bucket(walled, 0, 0);
    expect(painted(filled)).toBe(53 * 38 - 2);
    expect([getTile(filled, "layer-1", -10, 0), getTile(filled, "layer-1", -27, 0)]).toEqual([5, 0]);
    // A bounded map still stops at its own edge.
    const bounded = { ...mapWithTiles([]), width: 3, height: 2 };
    expect(tilemapBucketBounds(bounded, "layer-1", { x: 1, y: 1 })).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 });
  });

  it("stamps a bottom-left origin pattern", () => {
    const next = applyTilemapPaint(createDefaultTilemapPayload(), {
      tool: "stamp",
      layerId: "layer-1",
      tileId: 1,
      start: { x: 4, y: 2 },
      end: { x: 4, y: 2 },
      stamp: { width: 2, height: 2, tiles: [1, 2, 3, 4] },
    });
    expect(getTile(next, "layer-1", 4, 2)).toBe(1);
    expect(getTile(next, "layer-1", 5, 2)).toBe(2);
    expect(getTile(next, "layer-1", 4, 3)).toBe(3);
    expect(getTile(next, "layer-1", 5, 3)).toBe(4);
  });

  it("skips cells outside the map rectangle", () => {
    const next = applyTilemapPaint(createDefaultTilemapPayload(), {
      tool: "brush",
      layerId: "layer-1",
      tileId: 1,
      start: { x: 64, y: 0 },
      end: { x: 0, y: 0 },
      cells: [
        { x: 64, y: 0 },
        { x: 0, y: 0 },
      ],
    });
    expect(getTile(next, "layer-1", 64, 0)).toBe(0);
    expect(getTile(next, "layer-1", 0, 0)).toBe(1);
  });
});

describe("tilemapStrokeMergeKey", () => {
  it("namespaces the stroke id for the edit stack", () => {
    expect(tilemapStrokeMergeKey("abc")).toBe("tilemap-stroke:abc");
  });
});

describe("pickTileId", () => {
  it("reads the tile under the picker without mutating the map", () => {
    const map = mapWithTiles([[3, 1, 7]]);
    expect(pickTileId(map, "layer-1", 3, 1)).toBe(7);
    expect(pickTileId(map, "layer-1", 0, 0)).toBe(0);
  });
});
