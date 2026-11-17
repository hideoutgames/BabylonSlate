import { describe, expect, it } from "vitest";
import { ShadowAtlasAllocator, type ShadowAtlasTile } from "./shadow-atlas-allocator";

const overlaps = (a: ShadowAtlasTile, b: ShadowAtlasTile) =>
  a.layer === b.layer && a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size;

describe("Shadow atlas tiles", () => {
  it("packs tiles of different sizes without overlap, each inside one page, until the pages are full", () => {
    const atlas = new ShadowAtlasAllocator(2048, 1024);
    expect(atlas.pages).toBe(4);
    const tiles = [1024, 512, 512, 256, 256, 256, 256, 512, 1024, 1024].map((size) => atlas.allocate(size));
    expect(tiles.every(Boolean)).toBe(true);
    const placed = tiles as ShadowAtlasTile[];
    for (const tile of placed) expect(tile.layer >= 0 && tile.layer < 4 && tile.x + tile.size <= 1024 && tile.y + tile.size <= 1024).toBe(true);
    for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) expect(overlaps(placed[a]!, placed[b]!)).toBe(false);
    // Four 1024s' worth is the whole atlas.
    expect(atlas.allocate(256)).toBeNull();
  });

  it("places tiles where one quadtree over the whole edge would, its quarters the pages in order", () => {
    // High's sun (4096, 2048, 2048, 1024) then a 2048 spot map: the first cascade fills the first page, the rest share
    // the second, and the spot map takes the second page's last quarter, as the single atlas placed them.
    const atlas = new ShadowAtlasAllocator(8192, 4096);
    expect([4096, 2048, 2048, 1024, 2048].map((size) => atlas.allocate(size))).toEqual([
      { layer: 0, x: 0, y: 0, size: 4096 },
      { layer: 1, x: 0, y: 0, size: 2048 },
      { layer: 1, x: 2048, y: 0, size: 2048 },
      { layer: 1, x: 0, y: 2048, size: 1024 },
      { layer: 1, x: 2048, y: 2048, size: 2048 },
    ]);
    // No tile is wider than a page.
    expect(atlas.allocate(8192)).toBeNull();
  });

  it("tells whether a page holds only given tiles", () => {
    const atlas = new ShadowAtlasAllocator(1024, 512);
    const faces = [0, 1, 2, 3, 4].map(() => atlas.allocate(256)!);
    const own = new Set(faces);
    expect([atlas.holdsOnly(0, own), atlas.holdsOnly(1, own), atlas.holdsOnly(2, own)]).toEqual([true, true, true]);
    const other = atlas.allocate(256)!;
    expect(other.layer).toBe(1);
    expect([atlas.holdsOnly(0, own), atlas.holdsOnly(1, own)]).toEqual([true, false]);
    atlas.free(other);
    expect(atlas.holdsOnly(1, own)).toBe(true);
  });

  it("frees a tile for a later one and merges quarters back into a larger tile", () => {
    const atlas = new ShadowAtlasAllocator(1024);
    const quarters = [0, 1, 2, 3].map(() => atlas.allocate(512)!);
    expect(atlas.allocate(512)).toBeNull();
    atlas.free(quarters[2]!);
    const again = atlas.allocate(512);
    expect(again).toEqual({ layer: 0, x: 0, y: 512, size: 512 });
    for (const tile of [quarters[0]!, quarters[1]!, quarters[3]!, again!]) atlas.free(tile);
    expect(atlas.empty).toBe(true);
    expect(atlas.allocate(1024)).toEqual({ layer: 0, x: 0, y: 0, size: 1024 });
  });

  it("refuses a size that is not a power of two or is larger than a page, and pages that do not divide the edge", () => {
    const atlas = new ShadowAtlasAllocator(512);
    expect([atlas.allocate(300), atlas.allocate(1024), atlas.allocate(0)]).toEqual([null, null, null]);
    expect(() => new ShadowAtlasAllocator(1000)).toThrow();
    expect(() => new ShadowAtlasAllocator(512, 1024)).toThrow();
    expect(() => new ShadowAtlasAllocator(512, 300)).toThrow();
  });
});
