import { describe, expect, it } from "vitest";
import { ensureTilesetTiles, normalizeTilesetPayload } from "@haptic/assets";
import {
  atlasTileAt,
  atlasTileCell,
  atlasTilesInRect,
  drawAtlasTileGrid,
  visibleAtlasTiles,
} from "./atlas-tile-grid-canvas";

/** A 4 × 3 grid of 16 px tiles with a 2 px margin and 1 px spacing. */
const SPACED = ensureTilesetTiles(normalizeTilesetPayload({
  atlasWidth: 2 + 4 * 16 + 3 + 2,
  atlasHeight: 2 + 3 * 16 + 2 + 2,
  tileWidth: 16,
  tileHeight: 16,
  margin: 2,
  spacing: 1,
}));

/** Every draw call with the style it used, in order. */
function recordingContext() {
  const calls: Array<{ op: string; args: unknown[]; fill: unknown; stroke: unknown; alpha: number }> = [];
  const ctx = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    globalAlpha: 1,
  } as Record<string, unknown>;
  for (const op of ["setTransform", "clearRect", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "stroke", "arc", "fill", "save", "restore", "rect", "clip"]) {
    ctx[op] = (...args: unknown[]) => {
      calls.push({ op, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha as number });
    };
  }
  return { ctx: ctx as unknown as Parameters<typeof drawAtlasTileGrid>[0], calls };
}

const COLORS = { foreground: "fg", background: "bg", primary: "primary", selected: "amber" };

describe("atlas tile grid geometry", () => {
  it("names tiles by column and row, and nothing outside the grid", () => {
    expect(atlasTileCell(SPACED, 6)).toEqual({ column: 1, row: 1 });
    expect(atlasTileCell(SPACED, 13)).toBeNull();
    expect(atlasTileAt(SPACED, 3, 2)).toBe(12);
    expect(atlasTileAt(SPACED, 4, 0)).toBe(0);
    expect(atlasTileAt(SPACED, 0, -1)).toBe(0);
  });

  it("finds the tiles a rectangle touches from its column and row span, margin and spacing included", () => {
    // Columns start at 2, 19, 36, 53; rows at 2, 19, 36.
    expect(atlasTilesInRect(SPACED, { x: 18, y: 18, right: 19, bottom: 19 })).toEqual([1, 2, 5, 6]);
    expect(atlasTilesInRect(SPACED, { x: 36, y: 3, right: 70, bottom: 4 })).toEqual([3, 4]);
    // The margin and the spacing gaps alone touch nothing new; past the grid is clamped.
    expect(atlasTilesInRect(SPACED, { x: 0, y: 0, right: 1, bottom: 1 })).toEqual([]);
    expect(atlasTilesInRect(SPACED, { x: -50, y: 30, right: 500, bottom: 500 })).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("lists only the cells on the surface for a panned, zoomed view", () => {
    const sheet = ensureTilesetTiles(normalizeTilesetPayload({ atlasWidth: 2048, atlasHeight: 2048, tileWidth: 16, tileHeight: 16 }));
    // At 2× with the atlas shifted 100 px left and up, a 64 × 32 surface shows columns 3-5 and rows 3-4.
    const visible = visibleAtlasTiles(sheet, { scale: 2, x: -100, y: -100 }, 64, 32);
    expect(visible).toEqual([388, 389, 390, 516, 517, 518]);
    expect(visibleAtlasTiles(sheet, { scale: 2, x: 0, y: 0 }, 0, 32)).toEqual([]);
  });
});

describe("drawAtlasTileGrid", () => {
  it("draws borders, collision, marks, hover and selection for the visible cells only", () => {
    const tileset = ensureTilesetTiles(normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tiles: [
        { id: 1, collision: "full" },
        { id: 2, collision: { kind: "chain", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } },
      ],
    }));
    const { ctx, calls } = recordingContext();
    const drawn = drawAtlasTileGrid(ctx, {
      tileset,
      view: { scale: 2, x: 10, y: 5 },
      width: 200,
      height: 100,
      dpr: 2,
      selected: new Set([2]),
      marks: new Map([[1, "dim"], [2, "dot"]]),
      hover: 1,
      colors: COLORS,
    });
    expect(drawn).toBe(2);
    expect(calls[0]).toMatchObject({ op: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    const fills = calls.filter((call) => call.op === "fillRect").map((call) => [call.fill, call.alpha, ...call.args]);
    expect(fills).toEqual([
      // Full collision tint, the dimmed mark, then the hovered tile.
      ["primary", 0.2, 10, 5, 32, 32],
      ["bg", 0.6, 10, 5, 32, 32],
      ["fg", 0.1, 10, 5, 32, 32],
    ]);
    // The chain runs from the tile's bottom-left to its top-right, in surface pixels.
    const chain = calls.filter((call) => call.op === "moveTo" || call.op === "lineTo").slice(0, 2).map((call) => call.args);
    expect(chain).toEqual([[42, 37], [74, 5]]);
    // The unselected tile gets the 1 px border; the selected one the background halo and the 2 px ring.
    expect(calls.filter((call) => call.op === "rect").map((call) => call.args)).toEqual([[10.5, 5.5, 31, 31]]);
    expect(calls.filter((call) => call.op === "strokeRect").map((call) => [call.stroke, ...call.args])).toEqual([
      ["bg", 41.5, 4.5, 33, 33],
      ["amber", 43, 6, 30, 30],
    ]);
    expect(calls.filter((call) => call.op === "arc")).toHaveLength(2);
  });

  it("costs the cells in view, not the size of the atlas", () => {
    const sheet = ensureTilesetTiles(normalizeTilesetPayload({ atlasWidth: 2048, atlasHeight: 2048, tileWidth: 16, tileHeight: 16 }));
    const { ctx, calls } = recordingContext();
    const drawn = drawAtlasTileGrid(ctx, {
      tileset: sheet, view: { scale: 1, x: 0, y: 0 }, width: 160, height: 80, dpr: 1,
      selected: new Set([1, 5000]), hover: 0, colors: COLORS,
    });
    // 10 × 5 cells fill the surface; the cells starting on its right and bottom edges touch it.
    expect(drawn).toBe(11 * 6);
    expect(calls.filter((call) => call.op === "rect")).toHaveLength(11 * 6 - 1);
    expect(calls.filter((call) => call.op === "strokeRect")).toHaveLength(2);
  });
});
