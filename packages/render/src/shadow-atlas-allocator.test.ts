import { describe, expect, it } from "vitest";
import { ShadowAtlasAllocator, type ShadowAtlasTile } from "./shadow-atlas-allocator";

const overlaps = (a: ShadowAtlasTile, b: ShadowAtlasTile) =>
  a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size;

describe("Shadow atlas tiles", () => {
  it("packs tiles of different sizes without overlap, inside the atlas, until it is full", () => {
    const atlas = new ShadowAtlasAllocator(2048);
    const tiles = [1024, 512, 512, 256, 256, 256, 256, 512, 1024, 1024].map((size) => atlas.allocate(size));
    expect(tiles.every(Boolean)).toBe(true);
    const placed = tiles as ShadowAtlasTile[];
    for (const tile of placed) expect(tile.x + tile.size <= 2048 && tile.y + tile.size <= 2048).toBe(true);
    for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) expect(overlaps(placed[a]!, placed[b]!)).toBe(false);
    // Four 1024s' worth is the whole atlas.
    expect(atlas.allocate(256)).toBeNull();
  });

  it("frees a tile for a later one and merges quarters back into a larger tile", () => {
    const atlas = new ShadowAtlasAllocator(1024);
    const quarters = [0, 1, 2, 3].map(() => atlas.allocate(512)!);
    expect(atlas.allocate(512)).toBeNull();
    atlas.free(quarters[2]!);
    const again = atlas.allocate(512);
    expect(again).toEqual({ x: 0, y: 512, size: 512 });
    for (const tile of [quarters[0]!, quarters[1]!, quarters[3]!, again!]) atlas.free(tile);
    expect(atlas.allocate(1024)).toEqual({ x: 0, y: 0, size: 1024 });
  });

  it("refuses a size that is not a power of two or is larger than the atlas", () => {
    const atlas = new ShadowAtlasAllocator(512);
    expect([atlas.allocate(300), atlas.allocate(1024), atlas.allocate(0)]).toEqual([null, null, null]);
    expect(() => new ShadowAtlasAllocator(1000)).toThrow();
  });
});
