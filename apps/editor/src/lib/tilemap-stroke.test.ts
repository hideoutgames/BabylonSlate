import { describe, expect, it } from "vitest";
import {
  createDefaultTilemapPayload,
  ensureTilesetTiles,
  getTile,
  normalizeTilesetPayload,
  setTile,
  TERRAIN_E,
  TERRAIN_W,
  type TilemapPayload,
} from "@haptic/assets";
import { TilemapStroke } from "./tilemap-stroke";

const NO_TILESETS = new Map();

function map(width = 256, height = 256): TilemapPayload {
  return { ...createDefaultTilemapPayload(), tilesets: [{ guid: "ts", firstGid: 1, tileCount: 4 }], width, height };
}

const row = (painted: TilemapPayload, y: number, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, at) => getTile(painted, "layer-1", from + at, y));

describe("TilemapStroke", () => {
  it("queues each crossed Brush cell once, ignores moves inside the last cell and writes them in one flush", () => {
    const base = map();
    const stroke = new TilemapStroke(base, { tool: "brush", layerId: "layer-1", gid: 2, tilesets: NO_TILESETS, start: { x: 0, y: 0 } });
    expect(stroke.queued).toBe(true);
    expect(stroke.moveTo({ x: 0, y: 0 })).toBe(false);
    expect(stroke.moveTo({ x: 3, y: 0 })).toBe(true);
    // Back over cells already painted: nothing new to show.
    expect(stroke.moveTo({ x: 1, y: 0 })).toBe(false);
    // Nothing is written until the frame shows the stroke.
    expect(stroke.painted).toBe(base);
    const painted = stroke.flush();
    expect(row(painted, 0, 0, 4)).toEqual([2, 2, 2, 2, 0]);
    expect(stroke.flush()).toBe(painted);
    expect(stroke.moveTo({ x: 1, y: 2 })).toBe(true);
    expect(stroke.finish()).not.toBe(painted);
    expect([1, 2].map((y) => getTile(stroke.painted, "layer-1", 1, y))).toEqual([2, 2]);
  });

  it("writes nothing while a Rect is dragged, shows its cells, and paints the final rectangle once on release", () => {
    let base = map();
    base = setTile(base, "layer-1", 9, 9, 3);
    const stroke = new TilemapStroke(base, { tool: "rect", layerId: "layer-1", gid: 1, tilesets: NO_TILESETS, start: { x: 2, y: 2 } });
    expect(stroke.shape).toEqual({ minX: 2, minY: 2, maxX: 2, maxY: 2 });
    // The whole map's width of cells, then back: every move is just the outline.
    expect(stroke.moveTo({ x: 255, y: 255 })).toBe(true);
    expect(stroke.moveTo({ x: 255, y: 255 })).toBe(false);
    expect(stroke.moveTo({ x: 0, y: 4 })).toBe(true);
    expect(stroke.flush()).toBe(base);
    expect(stroke.painted).toBe(base);
    expect(stroke.shape).toEqual({ minX: 0, minY: 2, maxX: 2, maxY: 4 });
    const painted = stroke.finish();
    expect(row(painted, 2, 0, 3)).toEqual([1, 1, 1, 0]);
    expect(row(painted, 4, 0, 3)).toEqual([1, 1, 1, 0]);
    expect(getTile(painted, "layer-1", 1, 5)).toBe(0);
    // The shape grew past the tile at 9, 9 and shrank again: it is untouched.
    expect(getTile(painted, "layer-1", 9, 9)).toBe(3);
  });

  it("resolves a terrain Rect only on release", () => {
    // A ledge: 1 single, 2 left end, 3 middle, 4 right end.
    const ledge = ensureTilesetTiles(normalizeTilesetPayload({
      atlasWidth: 64,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      terrains: [{ id: "ledge", name: "Ledge", style: "sides" }],
      tiles: [0, TERRAIN_E, TERRAIN_E | TERRAIN_W, TERRAIN_W].map((mask, at) => ({ id: at + 1, terrain: { id: "ledge", mask } })),
    }));
    const base = map(8, 4);
    const stroke = new TilemapStroke(base, {
      tool: "rect", layerId: "layer-1", gid: 0, terrain: { guid: "ts", terrainId: "ledge" },
      tilesets: new Map([["ts", ledge]]), start: { x: 1, y: 1 },
    });
    stroke.moveTo({ x: 4, y: 1 });
    expect(stroke.flush()).toBe(base);
    expect(row(stroke.finish(), 1, 0, 5)).toEqual([0, 2, 3, 3, 4, 0]);
  });

  it("fills with the Bucket when the stroke starts and ignores its moves", () => {
    const base = map(4, 2);
    const stroke = new TilemapStroke(base, { tool: "bucket", layerId: "layer-1", gid: 4, tilesets: NO_TILESETS, start: { x: 0, y: 0 } });
    const painted = stroke.painted;
    expect(row(painted, 1, 0, 3)).toEqual([4, 4, 4, 4]);
    expect(stroke.moveTo({ x: 3, y: 1 })).toBe(false);
    expect(stroke.finish()).toBe(painted);
  });
});
