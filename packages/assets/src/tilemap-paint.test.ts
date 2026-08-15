import { describe, expect, it } from "vitest";
import { createDefaultTilemapPayload, getTile, setTile } from "./tilemap-payload";
import {
  applyTilemapPaint,
  cellsAlongSegment,
  paintCanvasTileAt,
  pickTileId,
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

  it("keeps a bucket fill inside the AABB of existing chunks", () => {
    const next = applyTilemapPaint(
      mapWithTiles([[0, 0, 0]], 4),
      {
        tool: "bucket",
        layerId: "layer-1",
        tileId: 9,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
      },
    );
    expect(getTile(next, "layer-1", 0, 0)).toBe(9);
    expect(getTile(next, "layer-1", 3, 3)).toBe(9);
    expect(getTile(next, "layer-1", 4, 0)).toBe(0);
    expect(getTile(next, "layer-1", 0, 4)).toBe(0);
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
