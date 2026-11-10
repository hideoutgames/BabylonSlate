import { afterEach, describe, expect, it } from "vitest";
import { createTestEngine } from "./test-support/test-engine";
import type { BitmapGlyphCell } from "./text2d-bitmap";
import { sceneGlyphAtlas, type AtlasGlyph } from "./text2d-glyph-atlas";

const handles: Array<ReturnType<typeof createTestEngine>> = [];
afterEach(() => { for (const { scene, engine } of handles.splice(0)) { scene.dispose(); engine.dispose(); } });

/** A Scene whose atlas pages are 16 texels a side: four 6 x 6 cells fill one, two to a shelf. */
function smallPages() {
  const handle = createTestEngine();
  handles.push(handle);
  handle.engine.getCaps().maxTextureSize = 16;
  const pages = () => handle.scene.textures.filter((texture) => texture.name.startsWith("text2d-glyph-atlas:"));
  return { scene: handle.scene, atlas: sceneGlyphAtlas(handle.scene, false), pages };
}

/** A cell every texel of which is `value`. */
const cell = (value: number, width = 6, height = 6): BitmapGlyphCell =>
  ({ key: `glyph ${value}`, width, height, pixels: new Uint8ClampedArray(width * height * 4).fill(value) });

/** The glyph's rectangle on its page, in texels from the top left, and the first channel of each texel in it. */
function drawn(glyph: AtlasGlyph) {
  const { width, height } = glyph.page.texture.getSize();
  const pixels = (glyph.page.texture.getInternalTexture() as unknown as { _bufferView: ArrayLike<number> })._bufferView;
  const left = glyph.uvs.u0 * width, right = glyph.uvs.u1 * width, top = (1 - glyph.uvs.v1) * height, bottom = (1 - glyph.uvs.v0) * height;
  const values = new Set<number>();
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) values.add(pixels[(y * width + x) * 4]!);
  return { page: glyph.page.id, left, top, right, bottom, values: [...values] };
}

/** The first channel of every texel of the page, row by row. */
function texels(glyph: AtlasGlyph): number[][] {
  const { width, height } = glyph.page.texture.getSize();
  const pixels = (glyph.page.texture.getInternalTexture() as unknown as { _bufferView: ArrayLike<number> })._bufferView;
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => pixels[(y * width + x) * 4]!));
}

describe("a Scene's glyph atlas", () => {
  it("places cells on shelves, a texel apart and a texel from the page's edges", () => {
    const { atlas, pages } = smallPages();
    const placed = [1, 2, 3, 4].map((value) => drawn(atlas.acquire(cell(value))));
    expect(placed).toEqual([
      { page: 0, left: 1, top: 1, right: 7, bottom: 7, values: [1] },
      { page: 0, left: 8, top: 1, right: 14, bottom: 7, values: [2] },
      { page: 0, left: 1, top: 8, right: 7, bottom: 14, values: [3] },
      { page: 0, left: 8, top: 8, right: 14, bottom: 14, values: [4] },
    ]);
    expect(pages()).toHaveLength(1);
    expect(pages()[0]!.getSize()).toEqual({ width: 16, height: 16 });
  });

  it("leaves every texel between and around the cells transparent", () => {
    const { atlas } = smallPages();
    const glyph = atlas.acquire(cell(9));
    atlas.acquire(cell(7));
    const row = (y: number) => texels(glyph)[y]!;
    expect(row(0)).toEqual(new Array(16).fill(0));
    expect(row(1)).toEqual([0, 9, 9, 9, 9, 9, 9, 0, 7, 7, 7, 7, 7, 7, 0, 0]);
    expect(row(7)).toEqual(new Array(16).fill(0));
  });

  it("finds a cell two texts hold once, and keeps it until both let go", () => {
    const { atlas, pages } = smallPages();
    const shared = cell(1);
    const first = atlas.acquire(shared);
    expect(atlas.acquire(shared)).toBe(first);
    for (const value of [2, 3, 4]) atlas.acquire(cell(value));
    atlas.release(shared);
    // The page is full and one text still holds the cell: a fifth cell opens a second page.
    expect(drawn(atlas.acquire(cell(5)))).toMatchObject({ page: 1, left: 1, top: 1 });
    expect(drawn(first).values).toEqual([1]);
    expect(pages()).toHaveLength(2);
  });

  it("gives a full page's room to a new cell only where no text holds a cell", () => {
    const { atlas, pages } = smallPages();
    const [first, second] = [cell(1), cell(2)];
    const held = [first, second, cell(3), cell(4)].map((entry) => atlas.acquire(entry));
    atlas.release(second);
    // A cell no text holds stays findable while the page has no need of its room.
    expect(atlas.acquire(second)).toBe(held[1]);
    atlas.release(second);
    expect(drawn(atlas.acquire(cell(5)))).toEqual({ page: 0, left: 8, top: 1, right: 14, bottom: 7, values: [5] });
    expect(pages()).toHaveLength(1);
    expect([held[0]!, held[2]!, held[3]!].map((glyph) => drawn(glyph).values)).toEqual([[1], [3], [4]]);
  });

  it("shows nothing of the cell a slot held when a smaller one takes it", () => {
    const { atlas } = smallPages();
    const large = cell(9);
    atlas.acquire(large);
    for (const value of [2, 3, 4]) atlas.acquire(cell(value));
    atlas.release(large);
    const small = atlas.acquire(cell(5, 3, 2));
    expect(drawn(small)).toEqual({ page: 0, left: 1, top: 1, right: 4, bottom: 3, values: [5] });
    expect(texels(small).slice(0, 8).map((row) => row.slice(0, 8))).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 5, 5, 5, 0, 0, 0, 0],
      [0, 5, 5, 5, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it("drops a page no text draws from when room is needed, and keeps the last one", () => {
    const { atlas, pages } = smallPages();
    const first = [1, 2, 3, 4].map((value) => cell(value));
    const second = [5, 6, 7, 8].map((value) => cell(value));
    for (const entry of [...first, ...second]) atlas.acquire(entry);
    expect(pages()).toHaveLength(2);
    for (const entry of second) atlas.release(entry);
    for (const entry of first) atlas.release(entry);
    // Nothing is held: a new cell takes the first page's first place, and the second page goes.
    expect(drawn(atlas.acquire(cell(9)))).toMatchObject({ page: 0, left: 1, top: 1 });
    expect(pages()).toHaveLength(1);
  });

  it("keeps pixel fonts on pages sampled without filtering, apart from every other glyph", () => {
    const { scene, atlas } = smallPages();
    const smooth = atlas.acquire(cell(1));
    const crisp = sceneGlyphAtlas(scene, true).acquire(cell(2));
    expect(crisp.page.texture).not.toBe(smooth.page.texture);
    expect([smooth.page.texture.samplingMode, crisp.page.texture.samplingMode]).toEqual([2, 1]);
    expect(sceneGlyphAtlas(scene, false)).toBe(atlas);
  });

  it("disposes its pages with the Scene", () => {
    const { scene, atlas } = smallPages();
    const texture = atlas.acquire(cell(1)).page.texture;
    const disposed: unknown[] = [];
    texture.onDisposeObservable.add(() => disposed.push(texture));
    scene.dispose();
    expect(disposed).toEqual([texture]);
  });
});
