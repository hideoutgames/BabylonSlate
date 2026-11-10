import { afterEach, describe, expect, it } from "vitest";
import type { RichTextStyle } from "@haptic/core";
import { FontRegistry, type FontFaceLike } from "./font-registry";
import { createTestEngine } from "./test-support/test-engine";
import { createText2DMesh, text2DMeshLayout } from "./text2d-mesh";
import {
  bitmapGlyphKey,
  measureBitmapGlyph,
  packBitmapGlyphAtlas,
  planBitmapGlyphAtlas,
  rasterizeBitmapGlyph,
  resolveText2DFontStack,
} from "./text2d-bitmap";

const STYLE: RichTextStyle = {
  bold: false,
  italic: false,
  underline: false,
  color: [1, 1, 1],
  size: 32,
  outline: 0,
  outlineColor: [0, 0, 0],
};

function opaqueCount(pixels: Uint8Array | Uint8ClampedArray): number {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 8) count += 1;
  }
  return count;
}

describe("rasterizeBitmapGlyph", () => {
  it("paints letter-shaped alpha, not a solid rectangle", () => {
    const cell = rasterizeBitmapGlyph("A", STYLE);
    const opaque = opaqueCount(cell.pixels);
    const total = cell.width * cell.height;
    expect(opaque).toBeGreaterThan(0);
    expect(opaque).toBeLessThan(total);
  });

  it("strokes the software outline Outline pixels past the glyph, not one dot", () => {
    // Size 32 scales each 5x7 dot to 5px, so a one-dot outline would be 5px wide.
    const outlineWidth = (outline: number) => {
      const cell = rasterizeBitmapGlyph("I", { ...STYLE, outline });
      let opaque = cell.width;
      let ink = cell.width;
      for (let y = 0; y < cell.height; y++) {
        for (let x = 0; x < cell.width; x++) {
          const i = (y * cell.width + x) * 4;
          if (cell.pixels[i + 3] === 0) continue;
          opaque = Math.min(opaque, x);
          if (cell.pixels[i] === 255) ink = Math.min(ink, x);
        }
      }
      return ink - opaque;
    };
    expect(outlineWidth(1)).toBe(1);
    expect(outlineWidth(3)).toBe(3);
  });

  function withMockCanvas(
    getImageData: (w: number, h: number) => Uint8ClampedArray,
    run: () => void,
    width: () => number = () => 16,
    baselineSensitive = false,
  ): void {
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document: unknown }).document = {
      createElement: () => ({
        width: 1,
        height: 1,
        getContext() {
          return {
            font: "",
            textBaseline: "alphabetic",
            textAlign: "left",
            fillStyle: "",
            strokeStyle: "",
            lineJoin: "",
            miterLimit: 0,
            lineWidth: 0,
            measureText() { return {
              width: width(),
              actualBoundingBoxAscent: baselineSensitive && this.textBaseline === "top" ? -4 : 16,
              actualBoundingBoxDescent: baselineSensitive && this.textBaseline === "top" ? 28 : 4,
            }; },
            clearRect() {},
            fillText() {},
            strokeText() {},
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: getImageData(w, h),
            }),
          };
        },
      }),
    };
    try {
      run();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        (globalThis as { document: unknown }).document = previous;
      }
    }
  }

  it("uses the raster baseline during preflight so stable native metrics remain admissible", () => {
    let readbacks = 0;
    withMockCanvas((w, h) => { readbacks += 1; return new Uint8ClampedArray(w * h * 4); }, () => {
      const glyph = rasterizeBitmapGlyph("A", STYLE);
      expect(opaqueCount(glyph.pixels)).toBeGreaterThan(0);
      expect(readbacks).toBe(1);
    }, () => 16, true);
  });

  it("centers inline images on painted letters rather than transparent canvas padding", () => {
    const { engine, scene } = createTestEngine();
    try {
      withMockCanvas((w, h) => {
        const pixels = new Uint8ClampedArray(w * h * 4);
        // Numeric alpha fixture: visible rows [6, 18), above the 58 px cell center.
        for (let y = 6; y < 18; y++) {
          pixels[(y * w + 3) * 4 + 3] = 255;
        }
        return pixels;
      }, () => {
        const mesh = createText2DMesh(scene, "inline", {
          text: "A[img=small size=14][img=large size=48]A",
          size: 32,
          wrapWidth: 0,
          wrapHeight: 0,
        }, { pixelsPerUnit: 100 }, { rich: true });
        // The two letters are one batch mesh; each image is its own plane.
        const images = mesh.getChildMeshes().filter((child) => child.metadata?.text2dSource === "image");
        const letters = text2DMeshLayout(mesh)!.items.filter((item) => item.kind === "glyph");
        expect(images).toHaveLength(2);
        // Ink center is 12 px from the top, so it sits 17 px above quad center.
        expect(images[0]?.position.y).toBeCloseTo(0.17);
        expect(images[1]?.position.y).toBeCloseTo(0.17);
        expect(letters).toHaveLength(2);
        expect(letters[0]!.y).toBeCloseTo(0);
        expect(letters[1]!.y).toBeCloseTo(0);
      }, () => 16, true);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("rejects changed canvas metrics before allocating glyph pixels", () => {
    let measurements = 0;
    let readbacks = 0;
    withMockCanvas((w, h) => { readbacks += 1; return new Uint8ClampedArray(w * h * 4); }, () => {
      expect(() => rasterizeBitmapGlyph("A", STYLE, "sans-serif", { maxTextureSize: 64, maxWorkingBytes: 1_000_000 })).toThrow(/allocation limit/i);
      expect(readbacks).toBe(0);
    }, () => ++measurements === 1 ? 16 : 1000);
  });

  it("falls back to the 5x7 bitmap when canvas paints a solid rectangle", () => {
    withMockCanvas((w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      data.fill(255);
      return data;
    }, () => {
      const cell = rasterizeBitmapGlyph("A", STYLE);
      const opaque = opaqueCount(cell.pixels);
      const total = cell.width * cell.height;
      expect(opaque).toBeGreaterThan(0);
      expect(opaque).toBeLessThan(total * 0.9);
    });
  });

  it("falls back to the 5x7 bitmap when canvas paints a solid glyph box with padding", () => {
    withMockCanvas((w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      const inset = 2;
      for (let y = inset; y < h - inset; y++) {
        for (let x = inset; x < w - inset; x++) {
          const i = (y * w + x) * 4;
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = 255;
        }
      }
      return data;
    }, () => {
      const cell = rasterizeBitmapGlyph("A", STYLE);
      // 5×7 at size 32: scale 5, plus 1px pad each side.
      expect(cell.width).toBe(5 * 5 + 2);
      expect(cell.height).toBe(7 * 5 + 2);
    });
  });

  it("keys unique cells by glyph, size, weight, and color", () => {
    expect(bitmapGlyphKey("A", STYLE, "sans-serif")).not.toBe(
      bitmapGlyphKey("B", STYLE, "sans-serif"),
    );
    expect(bitmapGlyphKey("A", { ...STYLE, bold: true }, "sans-serif")).not.toBe(
      bitmapGlyphKey("A", STYLE, "sans-serif"),
    );
  });
});

describe("rasterized glyphs kept between builds", () => {
  const original = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, "document");
    else (globalThis as { document: unknown }).document = original;
  });

  /**
   * Installs a document whose canvas counts the glyphs it measures and reads back. Every glyph measures `width` by
   * `ascent + descent` and paints a thin stroke, which is letter-shaped ink. `fontsLoaded` is the document telling
   * that its font faces finished loading.
   */
  function countingCanvas(metrics = { width: 16, ascent: 16, descent: 4 }) {
    const counts = { measured: 0, read: 0 };
    const listeners: Array<() => void> = [];
    (globalThis as { document: unknown }).document = {
      fonts: { addEventListener: (type: string, listener: () => void) => { if (type === "loadingdone") listeners.push(listener); } },
      createElement: () => ({
        width: 1,
        height: 1,
        getContext: () => ({
          font: "", textBaseline: "top", textAlign: "left", fillStyle: "", strokeStyle: "", lineJoin: "", miterLimit: 0, lineWidth: 0,
          measureText: () => { counts.measured += 1; return { width: metrics.width, actualBoundingBoxAscent: metrics.ascent, actualBoundingBoxDescent: metrics.descent }; },
          clearRect() {},
          fillText() {},
          strokeText() {},
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            counts.read += 1;
            const data = new Uint8ClampedArray(w * h * 4);
            for (let y = 6; y < 18; y++) data[(y * w + 3) * 4 + 3] = 255;
            return { data };
          },
        }),
      }),
    };
    return { counts, fontsLoaded: () => { for (const listener of listeners) listener(); } };
  }

  it("measures and reads a glyph back from the canvas once, whatever draws it again", () => {
    const { counts } = countingCanvas();
    const first = rasterizeBitmapGlyph("A", STYLE);
    // Measured for its cell, and again where it is painted.
    expect(counts).toEqual({ measured: 2, read: 1 });
    const again = rasterizeBitmapGlyph("A", STYLE);
    expect(counts).toEqual({ measured: 2, read: 1 });
    expect(again.pixels).toBe(first.pixels);
    expect([again.width, again.height]).toEqual([20, 24]);
  });

  it.each([
    { title: "another character", ch: "B", style: STYLE, stack: "sans-serif" },
    { title: "another colour", ch: "A", style: { ...STYLE, color: [1, 0, 0] as [number, number, number] }, stack: "sans-serif" },
    { title: "another size", ch: "A", style: { ...STYLE, size: 33 }, stack: "sans-serif" },
    { title: "a size the atlas key rounds to the same", ch: "A", style: { ...STYLE, size: 32.4 }, stack: "sans-serif" },
    { title: "another weight", ch: "A", style: { ...STYLE, bold: true }, stack: "sans-serif" },
    { title: "another slant", ch: "A", style: { ...STYLE, italic: true }, stack: "sans-serif" },
    { title: "another outline", ch: "A", style: { ...STYLE, outline: 2 }, stack: "sans-serif" },
    { title: "an outline the atlas key rounds to the same", ch: "A", style: { ...STYLE, outline: 0.04 }, stack: "sans-serif" },
    { title: "another outline colour", ch: "A", style: { ...STYLE, outlineColor: [0, 0, 1] as [number, number, number] }, stack: "sans-serif" },
    { title: "another font", ch: "A", style: STYLE, stack: "serif" },
  ])("draws $title anew", ({ ch, style, stack }) => {
    const { counts } = countingCanvas();
    rasterizeBitmapGlyph("A", STYLE, "sans-serif");
    rasterizeBitmapGlyph(ch, style, stack);
    expect(counts.read).toBe(2);
  });

  it("draws a glyph anew once the document's font faces finish loading", () => {
    const { counts, fontsLoaded } = countingCanvas();
    rasterizeBitmapGlyph("A", STYLE);
    fontsLoaded();
    rasterizeBitmapGlyph("A", STYLE);
    expect(counts.read).toBe(2);
  });

  it("draws a glyph anew when a registered Font's face loads, is replaced or leaves", async () => {
    const { counts } = countingCanvas();
    const faces: FontFaceLike[] = [];
    const registry = new FontRegistry({
      create: (family) => { const face: FontFaceLike = { family, load: async () => face }; return face; },
      add: (face) => { faces.push(face); },
      delete: (face) => { faces.splice(faces.indexOf(face), 1); },
    });
    const draws = () => { rasterizeBitmapGlyph("A", STYLE, "Game Font"); return counts.read; };
    expect(draws()).toBe(1);
    // Drawn so far from the fallback font: the face can draw it now.
    await registry.register({ guid: "font-1", family: "Game Font", bytes: new Uint8Array([1]) });
    expect(draws()).toBe(2);
    expect(draws()).toBe(2);
    await registry.register({ guid: "font-1", family: "Game Font", bytes: new Uint8Array([2]) });
    expect(draws()).toBe(3);
    registry.unregister("font-1");
    expect(faces).toEqual([]);
    expect(draws()).toBe(4);
  });

  it("draws a glyph anew on another document's canvas", () => {
    const first = countingCanvas();
    rasterizeBitmapGlyph("A", STYLE);
    const second = countingCanvas();
    rasterizeBitmapGlyph("A", STYLE);
    expect([first.counts.read, second.counts.read]).toEqual([1, 1]);
  });

  it("holds a kept glyph to the limits of whoever asks for it", () => {
    countingCanvas();
    rasterizeBitmapGlyph("A", STYLE);
    // The 20 x 24 cell is wider than this caller's largest texture.
    expect(() => rasterizeBitmapGlyph("A", STYLE, "sans-serif", { maxTextureSize: 16, maxWorkingBytes: 1_000_000 })).toThrow(/allocation limit/i);
  });

  it("keeps no more than 4096 glyphs", () => {
    const { counts } = countingCanvas();
    const measures = (index: number) => { measureBitmapGlyph(String.fromCodePoint(0x4e00 + index), STYLE); return counts.measured; };
    for (let index = 0; index < 4096; index++) measures(index);
    expect(measures(0)).toBe(4096);
    // One more drops the glyph measured longest ago, which glyph 0 no longer is.
    expect(measures(4096)).toBe(4097);
    expect(measures(0)).toBe(4097);
    expect(measures(1)).toBe(4098);
  });

  it("keeps the glyphs drawn most recently when they outgrow its 8 MB", () => {
    // Each cell is 720 x 712 texels, 2,050,560 bytes: four fit.
    const { counts } = countingCanvas({ width: 716, ascent: 500, descent: 208 });
    const draws = (ch: string) => { rasterizeBitmapGlyph(ch, STYLE); return counts.read; };
    expect(["A", "B", "C", "D"].map(draws)).toEqual([1, 2, 3, 4]);
    expect(draws("A")).toBe(4);
    // A fifth makes room by dropping B, the one drawn longest ago.
    expect(draws("E")).toBe(5);
    expect(draws("A")).toBe(5);
    expect(draws("B")).toBe(6);
  });
});

describe("resolveText2DFontStack", () => {
  it("prefers the Font guid stack, then the project stack, then sans-serif", () => {
    const assets = {
      fontCssStack: '"Project Face", sans-serif',
      fontCssStackByGuid: new Map([["font-1", '"Display", sans-serif']]),
    };
    expect(resolveText2DFontStack("font-1", assets)).toBe('"Display", sans-serif');
    expect(resolveText2DFontStack("missing", assets)).toBe(
      '"Project Face", sans-serif',
    );
    expect(resolveText2DFontStack(null)).toBe("sans-serif");
  });
});

describe("packBitmapGlyphAtlas", () => {
  it("rejects invalid dimensions and budgets including the retained representation before packing", () => {
    const limits = { maxTextureSize: 64, maxWorkingBytes: 1024 };
    for (const width of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
      expect(() => planBitmapGlyphAtlas([{ key: "A", width, height: 8 }], limits)).toThrow(/allocation limit/i);
    }
    expect(planBitmapGlyphAtlas([{ key: "A", width: 2, height: 2 }], limits)).toBeTruthy();
    expect(() => planBitmapGlyphAtlas([{ key: "A", width: 2, height: 2 }], { ...limits, retainedBytes: 900 })).toThrow(/allocation limit/i);
  });
  it("balances many unique small cells across both atlas dimensions", () => {
    const cells = Array.from({ length: 64 }, (_, index) => ({
      key: String(index), width: 8, height: 8, pixels: new Uint8ClampedArray(8 * 8 * 4).fill(index),
    }));
    const packed = packBitmapGlyphAtlas(cells)!;
    expect(packed.width).toBeLessThanOrEqual(128);
    expect(packed.height).toBeLessThanOrEqual(128);
    expect(packed.uvs.size).toBe(64);
    for (const cell of cells) {
      const uv = packed.uvs.get(cell.key)!;
      const x = Math.round(uv.u0 * packed.width);
      const y = Math.round((1 - uv.v1) * packed.height);
      expect(packed.pixels[(y * packed.width + x) * 4]).toBe(Number(cell.key));
    }
  });

  describe("for a text that keeps the atlas it owns", () => {
    const limits = { maxTextureSize: 256, maxWorkingBytes: 1024 * 1024 };
    const cell = (key: string) => ({ key, width: 8, height: 8 });
    const cells = [cell("a"), cell("b")];
    // Alone, two 8 x 8 cells stack in the smallest atlas: 16 wide holds one cell a row.
    const smallest = { width: 16, height: 32, placed: [{ ...cell("a"), x: 1, y: 1 }, { ...cell("b"), x: 1, y: 10 }] };

    it("plans the smallest atlas without one to keep", () => {
      expect(planBitmapGlyphAtlas(cells, limits)).toMatchObject(smallest);
    });

    it("packs the cells into the kept size, a pixel apart, when they fit it", () => {
      const plan = planBitmapGlyphAtlas(cells, limits, { width: 64, height: 64 });
      expect(plan).toMatchObject({ width: 64, height: 64, placed: [{ ...cell("a"), x: 1, y: 1 }, { ...cell("b"), x: 10, y: 1 }] });
      const packed = packBitmapGlyphAtlas(cells.map((entry, index) => ({ ...entry, pixels: new Uint8ClampedArray(8 * 8 * 4).fill(index + 1) })), limits, plan)!;
      expect([packed.width, packed.height]).toEqual([64, 64]);
      expect(packed.uvs.get("b")).toEqual({ u0: 10 / 64, v0: 1 - 9 / 64, u1: 18 / 64, v1: 1 - 1 / 64 });
      // The second cell starts at column 10 of row 1, after one transparent pixel.
      expect(Array.from(packed.pixels.slice((64 + 9) * 4, (64 + 11) * 4))).toEqual([0, 0, 0, 0, 2, 2, 2, 2]);
    });

    it.each([
      { title: "too short for the rows", keep: { width: 16, height: 16 }, cells },
      { title: "too narrow for a cell", keep: { width: 8, height: 64 }, cells },
      { title: "larger than the texture limit", keep: { width: 512, height: 16 }, cells },
    ])("plans the smallest atlas when the kept size is $title", ({ keep }) => {
      expect(planBitmapGlyphAtlas(cells, limits, keep)).toMatchObject(smallest);
    });

    it("plans the smallest atlas when the kept size is over the working-set budget", () => {
      // 16 x 32 needs 5120 working bytes; 64 x 64 would need 33792.
      const budget = { ...limits, maxWorkingBytes: 8000 };
      expect(planBitmapGlyphAtlas(cells, budget, { width: 64, height: 64 })).toMatchObject({ ...smallest, workingBytes: 5120 });
      expect(planBitmapGlyphAtlas(cells, { ...limits, maxWorkingBytes: 40000 }, { width: 64, height: 64 })).toMatchObject({ width: 64, height: 64, workingBytes: 33792 });
    });

    it("refuses what the limits refuse, whatever size is kept", () => {
      const refused = { maxTextureSize: 64, maxWorkingBytes: 1024, retainedBytes: 900 };
      expect(() => planBitmapGlyphAtlas([{ key: "A", width: 2, height: 2 }], refused, { width: 64, height: 64 })).toThrow(/allocation limit/i);
    });
  });

  it("assigns distinct UVs and copies both cells onto one atlas", () => {
    const a = rasterizeBitmapGlyph("A", STYLE);
    const i = rasterizeBitmapGlyph("I", STYLE);
    const packed = packBitmapGlyphAtlas([a, i]);
    expect(packed).toBeTruthy();
    const uvA = packed!.uvs.get(a.key);
    const uvI = packed!.uvs.get(i.key);
    expect(uvA).toBeTruthy();
    expect(uvI).toBeTruthy();
    expect(uvA).not.toEqual(uvI);
    expect(opaqueCount(packed!.pixels)).toBeGreaterThan(0);
  });
});
