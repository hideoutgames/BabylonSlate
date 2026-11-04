import { describe, expect, it } from "vitest";
import {
  addTilemapLayer,
  createDefaultTilemapPayload,
  ensureTilesetTiles,
  normalizeTilesetPayload,
  setTile,
  type TilemapPayload,
} from "@haptic/assets";
import { placeholderCss, TilemapPaintRenderer, type PaintSurface, type TilemapPaintFrame } from "./tilemap-paint-renderer";

type Call = { op: string; args: unknown[]; fill: unknown };

/** A context that records its calls with the fill they used. */
function recordingContext() {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1, imageSmoothingEnabled: true };
  for (const op of ["setTransform", "clearRect", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo", "stroke", "save", "restore", "clip", "rect", "strokeRect"]) {
    ctx[op] = (...args: unknown[]) => calls.push({ op, args, fill: ctx.fillStyle });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Offscreen bitmaps that record what they were drawn with. */
function surfaces() {
  const made: Array<{ surface: PaintSurface; calls: Call[] }> = [];
  const create = (width: number, height: number) => {
    const { ctx, calls } = recordingContext();
    const surface = { width, height, getContext: () => ctx } as unknown as PaintSurface;
    made.push({ surface, calls });
    return surface;
  };
  return { create, made };
}

/** A 256 × 256 map whose three layers are full, chunk by chunk, of `gid`. */
function denseMap(): TilemapPayload {
  let map: TilemapPayload = { ...createDefaultTilemapPayload(), width: 256, height: 256, tilesets: [{ guid: "ts", firstGid: 1, tileCount: 4 }] };
  map = addTilemapLayer(addTilemapLayer(map));
  const tiles = Array<number>(32 * 32).fill(1);
  return {
    ...map,
    layers: map.layers.map((layer) => ({
      ...layer,
      chunks: Array.from({ length: 64 }, (_, at) => ({ cx: at % 8, cy: Math.floor(at / 8), tiles })),
    })),
  };
}

/** The loaded Tilesets and atlases, the same maps from frame to frame as the Paint panel's loaders publish them. */
const NO_PAYLOADS = new Map();
const NO_ATLASES = new Map();

function frame(tilemap: TilemapPayload, overrides: Partial<TilemapPaintFrame> = {}): TilemapPaintFrame {
  return {
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    tilemap,
    pan: { x: 0, y: 0 },
    cellSize: 16,
    payloads: NO_PAYLOADS,
    atlases: NO_ATLASES,
    sortingLayers: ["Default"],
    ...overrides,
  };
}

describe("TilemapPaintRenderer", () => {
  it("draws each chunk in view into its bitmap once, and on a pan or a stroke redraws only chunks whose cells changed", () => {
    const { create } = surfaces();
    const renderer = new TilemapPaintRenderer(create);
    const map = denseMap();
    // 800 × 600 at 16 px a cell shows 2 × 2 chunks of 512 px, on each of 3 layers.
    expect(renderer.draw(recordingContext().ctx, frame(map))).toEqual({ composited: 12, rendered: 12, direct: 0 });
    // A pan within the same chunks composites them again and draws no tile.
    expect(renderer.draw(recordingContext().ctx, frame(map, { pan: { x: -100, y: -40 } }))).toEqual({ composited: 12, rendered: 0, direct: 0 });
    // A pan onto a new column of chunks draws only those.
    expect(renderer.draw(recordingContext().ctx, frame(map, { pan: { x: -600, y: 0 } }))).toEqual({ composited: 12, rendered: 6, direct: 0 });
    // A painted cell replaces one chunk of one layer.
    const painted = setTile(map, "layer-2", 40, 5, 2);
    expect(renderer.draw(recordingContext().ctx, frame(painted, { pan: { x: -600, y: 0 } }))).toEqual({ composited: 12, rendered: 1, direct: 0 });
    // A zoom keeps every bitmap: one chunk per layer fills the view at 32 px a cell.
    expect(renderer.draw(recordingContext().ctx, frame(painted, { cellSize: 32 }))).toEqual({ composited: 3, rendered: 0, direct: 0 });
  });

  it("leaves hidden layers, chunks out of view and cells outside the map off the canvas", () => {
    const { create, made } = surfaces();
    const renderer = new TilemapPaintRenderer(create);
    let map = denseMap();
    map = { ...map, width: 40, height: 20, layers: map.layers.map((layer, at) => ({ ...layer, visible: at !== 1 })) };
    const { ctx, calls } = recordingContext();
    expect(renderer.draw(ctx, frame(map))).toEqual({ composited: 4, rendered: 4, direct: 0 });
    // Chunk 1, 0 holds 8 of its 32 columns inside the map, and its bitmap only those.
    const partial = calls.filter((call) => call.op === "drawImage")[1]!.args.slice(1);
    expect(partial).toEqual([0, 512 - 20 * 16, 8 * 16, 20 * 16, 512, 600 - 20 * 16, 8 * 16, 20 * 16]);
    expect(made[1]!.calls.filter((call) => call.op === "fillRect")).toHaveLength(8 * 20);
  });

  it("draws a tile from its atlas cell, or its placeholder colour while the atlas is missing", () => {
    const { create, made } = surfaces();
    const renderer = new TilemapPaintRenderer(create);
    const tileset = ensureTilesetTiles(normalizeTilesetPayload({ textureGuid: "tex", atlasWidth: 32, atlasHeight: 32, tileWidth: 16, tileHeight: 16 }));
    let map: TilemapPayload = { ...createDefaultTilemapPayload(), tilesets: [{ guid: "ts", firstGid: 1, tileCount: 4 }] };
    map = setTile(setTile(map, "layer-1", 0, 0, 4), "layer-1", 1, 0, 9);
    const atlas = { naturalWidth: 32, naturalHeight: 32 } as HTMLImageElement;
    renderer.draw(recordingContext().ctx, frame(map, { payloads: new Map([["ts", tileset]]), atlases: new Map([["ts", atlas]]) }));
    const bitmap = made[0]!.calls;
    // GID 4 is the atlas's bottom-right cell; GID 9 belongs to no Tileset.
    expect(bitmap.find((call) => call.op === "drawImage")!.args).toEqual([atlas, 16, 16, 16, 16, 0, 512 - 16, 16, 16]);
    expect(bitmap.find((call) => call.op === "fillRect")).toMatchObject({ args: [16, 512 - 16, 16, 16], fill: placeholderCss(9) });
  });

  it("draws large tiles straight from the atlas at full source resolution once a cell needs more pixels than its bitmap holds", () => {
    const { create } = surfaces();
    const renderer = new TilemapPaintRenderer(create);
    // 128 px tiles: a chunk bitmap holds 32 px of each.
    const tileset = ensureTilesetTiles(normalizeTilesetPayload({ textureGuid: "tex", atlasWidth: 256, atlasHeight: 256, tileWidth: 128, tileHeight: 128 }));
    const atlas = { naturalWidth: 256, naturalHeight: 256 } as HTMLImageElement;
    let map: TilemapPayload = { ...createDefaultTilemapPayload(), width: 128, tileWidth: 128, tileHeight: 128, tilesets: [{ guid: "ts", firstGid: 1, tileCount: 4 }] };
    // Two tiles at the bottom-left, and one in a chunk out of view at every zoom below.
    map = setTile(setTile(setTile(map, "layer-1", 0, 0, 4), "layer-1", 1, 0, 2), "layer-1", 100, 10, 3);
    const loaded = { payloads: new Map([["ts", tileset]]), atlases: new Map([["ts", atlas]]) };
    const drawImages = (calls: Call[]) => calls.filter((call) => call.op === "drawImage").map((call) => call.args);

    // 16 CSS px at DPR 2 is 32 device pixels a cell: the bitmaps are sharp enough.
    const zoomedOut = recordingContext();
    expect(renderer.draw(zoomedOut.ctx, frame(map, { ...loaded, dpr: 2 }))).toMatchObject({ direct: 0, rendered: 1 });
    expect(drawImages(zoomedOut.calls).every(([source]) => source !== atlas)).toBe(true);

    // 64 CSS px at DPR 2 is 128 device pixels a cell: each tile in view comes from its whole 128 px atlas cell.
    const zoomedIn = recordingContext();
    expect(renderer.draw(zoomedIn.ctx, frame(map, { ...loaded, dpr: 2, cellSize: 64 }))).toEqual({ composited: 0, rendered: 0, direct: 2 });
    expect(drawImages(zoomedIn.calls)).toEqual([
      [atlas, 128, 128, 128, 128, 0, 600 - 64, 64, 64],
      [atlas, 128, 0, 128, 128, 64, 600 - 64, 64, 64],
    ]);
    // Just past the bitmaps' 32 px, the atlas is drawn too.
    expect(renderer.draw(recordingContext().ctx, frame(map, { ...loaded, dpr: 2, cellSize: 17 }))).toMatchObject({ composited: 0, direct: 2 });
  });

  it("drops the bitmaps the latest frame did not draw once they pass its memory budget", () => {
    const { create } = surfaces();
    // Six 512 × 512 bitmaps fit.
    const renderer = new TilemapPaintRenderer(create, 6 * 512 * 512 * 4);
    const map = denseMap();
    // A 400 px view at 16 px a cell shows one chunk of each layer: chunk k, k at a pan of -(512 k + 10).
    const at = (k: number) => frame(map, { cssWidth: 400, cssHeight: 400, pan: { x: -(512 * k + 10), y: -(512 * k + 10) } });
    renderer.draw(recordingContext().ctx, at(0));
    expect(renderer.bitmapCount).toBe(3);
    renderer.draw(recordingContext().ctx, at(5));
    expect(renderer.bitmapCount).toBe(6);
    // A third place keeps its own three and the most recently drawn others, within the budget.
    expect(renderer.draw(recordingContext().ctx, at(3))).toMatchObject({ rendered: 3 });
    expect(renderer.bitmapCount).toBe(6);
    expect(renderer.draw(recordingContext().ctx, at(5))).toMatchObject({ rendered: 0 });
    expect(renderer.draw(recordingContext().ctx, at(0))).toMatchObject({ rendered: 3 });
  });
});
