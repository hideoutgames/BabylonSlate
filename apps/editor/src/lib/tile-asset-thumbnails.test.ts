import { describe, expect, it } from "vitest";
import {
  createDefaultTilesetPayload,
  createTilemapLayer,
  type IndexedAsset,
  type TilemapLayer,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import {
  tilemapThumbnailPlan,
  tilesetThumbnailPlan,
  tileThumbnailJobs,
  tileThumbnailTargets,
  type ThumbnailAtlas,
  type ThumbnailContext,
} from "./tile-asset-thumbnails";

type Call =
  | { kind: "image"; image: unknown; source: number[]; target: number[] }
  | { kind: "fill"; color: string; target: number[] };

/** A 2D context that records what a plan draws. */
function recorder() {
  const calls: Call[] = [];
  const ctx = {
    fillStyle: "",
    imageSmoothingEnabled: true,
    drawImage: (image: unknown, ...rest: number[]) => {
      calls.push({ kind: "image", image, source: rest.slice(0, 4), target: rest.slice(4) });
    },
    fillRect: (...target: number[]) => {
      calls.push({ kind: "fill", color: ctx.fillStyle, target });
    },
  };
  return { ctx: ctx as unknown as ThumbnailContext, calls, smoothing: () => ctx.imageSmoothingEnabled };
}

const atlas = (name: string, width: number, height: number): ThumbnailAtlas =>
  ({ image: name as unknown as CanvasImageSource, width, height });

/** A 32 × 32 sheet of 16 px tiles: tile 1 at (0, 0), 2 at (16, 0), 3 at (0, 16), 4 at (16, 16). */
const SHEET: TilesetPayload = { ...createDefaultTilesetPayload(), textureGuid: "texture", atlasWidth: 32, atlasHeight: 32 };

/** A layer of 4 × 4 chunks with `cells` painted: `[x, y, gid]`, +Y up. */
function layer(id: string, cells: Array<[number, number, number]>, patch: Partial<TilemapLayer> = {}): TilemapLayer {
  const chunks = new Map<string, { cx: number; cy: number; tiles: number[] }>();
  for (const [x, y, gid] of cells) {
    const cx = Math.floor(x / 4);
    const cy = Math.floor(y / 4);
    const key = `${cx},${cy}`;
    const chunk = chunks.get(key) ?? { cx, cy, tiles: new Array(16).fill(0) };
    chunk.tiles[(y - cy * 4) * 4 + (x - cx * 4)] = gid;
    chunks.set(key, chunk);
  }
  return { ...createTilemapLayer(id, id), chunks: [...chunks.values()], ...patch };
}

function boundedMap(layers: TilemapLayer[], width = 8, height = 8): TilemapPayload {
  return {
    tilesets: [{ guid: "sheet", firstGid: 1, tileCount: 4 }],
    tileWidth: 16, tileHeight: 16, chunkSize: 4, width, height, layers,
  };
}

function draw(plan: ReturnType<typeof tilemapThumbnailPlan>) {
  const record = recorder();
  plan!.draw(record.ctx);
  return record;
}

describe("Tileset thumbnails", () => {
  it("draws the sheet's part of its atlas fitted into 128 px, smoothed only when it shrinks", () => {
    const large = recorder();
    const plan = tilesetThumbnailPlan({ ...SHEET, atlasWidth: 512, atlasHeight: 256 }, atlas("big", 512, 256))!;
    expect([plan.width, plan.height]).toEqual([128, 64]);
    plan.draw(large.ctx);
    expect(large.calls).toEqual([{ kind: "image", image: "big", source: [0, 0, 512, 256], target: [0, 0, 128, 64] }]);
    expect(large.smoothing()).toBe(true);

    // A small sheet grows with sharp pixels; an atlas image smaller than the sheet draws only the pixels it has.
    const small = recorder();
    const grown = tilesetThumbnailPlan({ ...SHEET, atlasWidth: 64, atlasHeight: 32 }, atlas("small", 48, 32))!;
    expect([grown.width, grown.height]).toEqual([128, 85]);
    grown.draw(small.ctx);
    expect(small.calls).toEqual([{ kind: "image", image: "small", source: [0, 0, 48, 32], target: [0, 0, 128, 85] }]);
    expect(small.smoothing()).toBe(false);
  });
});

describe("Tilemap thumbnails", () => {
  const tilesets = new Map([["sheet", SHEET]]);
  const atlases = new Map([["sheet", atlas("sheet-atlas", 32, 32)]]);

  it("draws the visible layers' painted cells in sorting order, top row first", () => {
    const map = boundedMap([
      // Listed first but drawn last: it is later in the sorting order.
      layer("Decor", [[2, 2, 2]], { orderInLayer: 1 }),
      layer("Ground", [[1, 1, 1], [2, 1, 2], [1, 2, 3]]),
      layer("Hidden", [[6, 6, 4]], { visible: false }),
    ]);
    const plan = tilemapThumbnailPlan(map, tilesets, atlases);
    // The 2 × 2 painted cells; the hidden layer's cell does not widen it.
    expect([plan!.width, plan!.height]).toEqual([128, 128]);
    expect(draw(plan).calls).toEqual([
      { kind: "image", image: "sheet-atlas", source: [0, 16, 16, 16], target: [0, 0, 64, 64] },
      { kind: "image", image: "sheet-atlas", source: [0, 0, 16, 16], target: [0, 64, 64, 64] },
      { kind: "image", image: "sheet-atlas", source: [16, 0, 16, 16], target: [64, 64, 64, 64] },
      { kind: "image", image: "sheet-atlas", source: [16, 0, 16, 16], target: [64, 0, 64, 64] },
    ]);
  });

  it("keeps the map's tile proportions", () => {
    const map = { ...boundedMap([layer("Ground", [[0, 0, 1], [1, 0, 1]])]), tileHeight: 32 };
    // Two 16 × 32 cells side by side are square.
    const plan = tilemapThumbnailPlan(map, tilesets, atlases)!;
    expect([plan.width, plan.height]).toEqual([128, 128]);
    expect(draw(plan).calls.map((call) => call.target)).toEqual([[0, 0, 64, 128], [64, 0, 64, 128]]);
  });

  it("draws a tile without an atlas image, or of a missing Tileset, in its placeholder colour", () => {
    const map = boundedMap([layer("Ground", [[0, 0, 2], [1, 0, 9]])]);
    expect(draw(tilemapThumbnailPlan(map, tilesets, new Map())).calls).toEqual([
      // Hue 47° per GID, as Paint and the chunk meshes colour it.
      { kind: "fill", color: "hsl(94 55% 48%)", target: [0, 0, 64, 64] },
      { kind: "fill", color: "hsl(63 55% 48%)", target: [64, 0, 64, 64] },
    ]);
  });

  it("leaves out cells outside a bounded map and reads negative cells of an unbounded one", () => {
    const bounded = boundedMap([layer("Ground", [[1, 1, 1], [3, 3, 2]])], 2, 2);
    expect(draw(tilemapThumbnailPlan(bounded, tilesets, atlases)).calls).toEqual([
      { kind: "image", image: "sheet-atlas", source: [0, 0, 16, 16], target: [0, 0, 128, 128] },
    ]);

    const unbounded: TilemapPayload = {
      tilesets: bounded.tilesets, tileWidth: 16, tileHeight: 16, chunkSize: 4,
      unbounded: true, pivot: { x: 0, y: 0 }, layers: [layer("Ground", [[-1, -1, 1], [0, 0, 2]])],
    };
    expect(draw(tilemapThumbnailPlan(unbounded, tilesets, atlases)).calls.map((call) => call.target)).toEqual([
      [64, 0, 64, 64],
      [0, 64, 64, 64],
    ]);
  });

  it("draws one cell per block that shares a pixel on a map wider than the thumbnail, covering its whole width", () => {
    const cells = Array.from({ length: 300 }, (_, x): [number, number, number] => [x, 0, 1]);
    const plan = tilemapThumbnailPlan(boundedMap([layer("Ground", cells)], 300, 1), tilesets, atlases)!;
    expect([plan.width, plan.height]).toEqual([128, 1]);
    const targets = draw(plan).calls.map((call) => call.target);
    // 128 / 300 px per cell: every third cell, each block 3 cells wide.
    expect(targets).toHaveLength(100);
    expect(targets[0]).toEqual([0, 0, 1, 1]);
    for (let index = 1; index < targets.length; index++) {
      expect(targets[index]![0]).toBe(targets[index - 1]![0]! + targets[index - 1]![2]!);
    }
    expect(targets.at(-1)![0]! + targets.at(-1)![2]!).toBe(128);
  });

  it("has no thumbnail when no visible layer paints a cell", () => {
    expect(tilemapThumbnailPlan(boundedMap([layer("Ground", [])]), tilesets, atlases)).toBeNull();
    expect(tilemapThumbnailPlan(boundedMap([layer("Ground", [[0, 0, 1]], { visible: false })]), tilesets, atlases)).toBeNull();
  });
});

function asset(guid: string, type: string, dependencies: string[] = []): IndexedAsset {
  return {
    rootId: "project",
    path: `Content/${guid}.hasset`,
    header: {
      guid, type, name: guid, version: 1, engineVersion: "1", mode: "thin",
      payload: {}, dependencies, requiredDependencies: [], dependencyMetadataVersion: 1, chunks: [],
    },
  };
}

describe("Tile thumbnail jobs", () => {
  const assets = [
    asset("texture", "Texture"),
    asset("other-texture", "Texture"),
    asset("tileset", "Tileset", ["texture"]),
    asset("other-tileset", "Tileset", ["other-texture"]),
    asset("map", "Tilemap", ["tileset", "other-tileset"]),
    asset("other-map", "Tilemap", ["other-tileset"]),
    asset("material", "Material", ["texture"]),
  ];
  const guids = (changed: string[]) => tileThumbnailTargets(assets, changed).map((entry) => entry.header.guid).sort();

  it("draws a saved Tileset or Tilemap and every Tileset and Tilemap showing a saved asset", () => {
    expect(guids(["texture"])).toEqual(["map", "tileset"]);
    expect(guids(["other-tileset"])).toEqual(["map", "other-map", "other-tileset"]);
    expect(guids(["map"])).toEqual(["map"]);
    expect(guids(["material"])).toEqual([]);
  });

  it("survives dependency cycles", () => {
    const cyclic = [asset("a", "Tileset", ["b"]), asset("b", "Tilemap", ["a"])];
    expect(tileThumbnailTargets(cyclic, ["a"]).map((entry) => entry.header.guid).sort()).toEqual(["a", "b"]);
  });

  it("keys each job by the asset's saved revision for this project", async () => {
    const jobs = await tileThumbnailJobs(assets, ["tileset"], "project-a");
    expect(jobs.map((job) => [job.guid, job.type, job.projectGuid]).sort()).toEqual([
      ["map", "Tilemap", "project-a"],
      ["tileset", "Tileset", "project-a"],
    ]);
    for (const job of jobs) expect(job.cacheKey).toMatch(new RegExp(`^${job.guid}\\.preview-v1\\.[0-9a-f]{64}$`));
  });
});
