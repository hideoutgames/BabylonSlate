import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { afterEach, describe, expect, it } from "vitest";
import type { RichTextStyle } from "@haptic/core";
import { createTestEngine } from "./test-support/test-engine";
import { createText2DMesh, text2DMeshLayout } from "./text2d-mesh";
import {
  measurePixelGlyph,
  pixelGlyphKey,
  pixelScaleOf,
  rasterizePixelGlyph,
  resolveText2DFont,
} from "./text2d-bitmap";

const PIXEL_SIZE = 12;
const STYLE: RichTextStyle = {
  bold: false,
  italic: false,
  underline: false,
  color: [1, 0, 0],
  size: PIXEL_SIZE,
  outline: 0,
  outlineColor: [0, 0, 1],
};

/** A pixel font's canvas: 6 px advances, a 10 px ascent and 2 px descent, and coverage the test paints. */
function withPixelCanvas(coverage: (x: number, y: number) => number, run: () => void): void {
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
          measureText: (text: string) => ({
            width: text.length * 6,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: text.length * 6,
            actualBoundingBoxAscent: 9,
            actualBoundingBoxDescent: 0,
            fontBoundingBoxAscent: 10,
            fontBoundingBoxDescent: 2,
          }),
          clearRect() {},
          fillText() {},
          strokeText() {},
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = coverage(x, y);
            return { data };
          },
        };
      },
    }),
  };
  try {
    run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "document");
    else (globalThis as { document: unknown }).document = previous;
  }
}

/** Coverage of a 2×3 block at columns 2–3, rows 4–6, with soft edges around it. */
const block = (x: number, y: number) =>
  x >= 2 && x <= 3 && y >= 4 && y <= 6 ? 255 : x === 4 && y >= 4 && y <= 6 ? 140 : x === 1 && y === 5 ? 90 : 0;

function alphaAt(cell: { width: number; pixels: Uint8Array | Uint8ClampedArray }, x: number, y: number) {
  return cell.pixels[(y * cell.width + x) * 4 + 3];
}

describe("pixel font glyphs", () => {
  it("draw at the native size with every texel either fully drawn or empty", () => {
    withPixelCanvas(block, () => {
      const cell = rasterizePixelGlyph("A", { ...STYLE, size: 36 }, '"Ark"', PIXEL_SIZE)!;
      // 1 px pad, 10 px ascent, 2 px descent, 1 px pad; the advance plus a pad either side.
      expect(cell.height).toBe(14);
      expect(cell.width).toBe(8);
      expect(cell.originX).toBe(1);
      expect(cell.advance).toBe(6);
      const alphas = new Set<number>();
      for (let i = 3; i < cell.pixels.length; i += 4) alphas.add(cell.pixels[i]!);
      expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
      // Coverage at or above half is drawn in the fill colour; below half is dropped.
      expect(alphaAt(cell, 4, 5)).toBe(255);
      expect(alphaAt(cell, 1, 5)).toBe(0);
      expect([...cell.pixels.subarray((5 * cell.width + 2) * 4, (5 * cell.width + 2) * 4 + 3)]).toEqual([255, 0, 0]);
    });
  });

  it("outline by whole font pixels, scaled down with the text's Scale", () => {
    withPixelCanvas(block, () => {
      // Outline 2 at Scale 2 is one font pixel around the fill.
      const cell = rasterizePixelGlyph("A", { ...STYLE, size: 24, outline: 2 }, '"Ark"', PIXEL_SIZE)!;
      const at = (x: number, y: number) => [...cell.pixels.subarray((y * cell.width + x) * 4, (y * cell.width + x) * 4 + 4)];
      expect(at(1, 5)).toEqual([0, 0, 255, 255]);
      expect(at(5, 3)).toEqual([0, 0, 255, 255]);
      expect(at(6, 5)).toEqual([0, 0, 0, 0]);
      expect(at(3, 5)).toEqual([255, 0, 0, 255]);
    });
  });

  it("share one atlas cell across Scales", () => {
    expect(pixelGlyphKey("A", { ...STYLE, size: 12 }, '"Ark"', PIXEL_SIZE)).toBe(pixelGlyphKey("A", { ...STYLE, size: 48 }, '"Ark"', PIXEL_SIZE));
    expect(pixelGlyphKey("A", STYLE, '"Ark"', PIXEL_SIZE)).not.toBe(pixelGlyphKey("B", STYLE, '"Ark"', PIXEL_SIZE));
    expect(pixelScaleOf({ ...STYLE, size: 30 }, PIXEL_SIZE)).toBe(3);
    expect(pixelScaleOf({ ...STYLE, size: 4 }, PIXEL_SIZE)).toBe(1);
  });

  it("measure the same cell they draw", () => {
    withPixelCanvas(block, () => {
      const measured = measurePixelGlyph("A", STYLE, '"Ark"', PIXEL_SIZE)!;
      const cell = rasterizePixelGlyph("A", STYLE, '"Ark"', PIXEL_SIZE)!;
      expect({ width: measured.width, height: measured.height, originX: measured.originX, advance: measured.advance, key: measured.key })
        .toEqual({ width: cell.width, height: cell.height, originX: cell.originX, advance: cell.advance, key: cell.key });
    });
  });
});

describe("resolveText2DFont", () => {
  const assets = {
    fontCssStack: '"Ark", sans-serif',
    fontCssStackByGuid: new Map([["ark", '"Ark", sans-serif'], ["body", '"Body", sans-serif']]),
    fontPixelSize: 12,
    fontPixelSizeByGuid: new Map([["ark", 10]]),
  };

  it("reads the named Font's Pixel Size, else the project default Font's", () => {
    expect(resolveText2DFont("ark", assets)).toEqual({ stack: '"Ark", sans-serif', pixelSize: 10 });
    expect(resolveText2DFont("body", assets).pixelSize).toBe(0);
    expect(resolveText2DFont(null, assets).pixelSize).toBe(12);
    expect(resolveText2DFont("missing", assets).pixelSize).toBe(12);
    expect(resolveText2DFont(null, { fontPixelSize: 2.5 }).pixelSize).toBe(0);
  });
});

describe("pixel font 2D Text", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  function build(properties: Record<string, unknown>, rich = false) {
    const { engine, scene } = createTestEngine();
    dispose = () => {
      scene.dispose();
      engine.dispose();
    };
    let mesh: ReturnType<typeof createText2DMesh> | undefined;
    withPixelCanvas(block, () => {
      mesh = createText2DMesh(scene, "pixel", { wrapWidth: 0, wrapHeight: 0, ...properties }, {
        pixelsPerUnit: 100,
        fontCssStack: '"Ark", sans-serif',
        fontPixelSize: PIXEL_SIZE,
      }, { rich });
    });
    return { mesh: mesh!, scene };
  }

  it("draws at Pixel Size × Scale with nearest sampling, ignoring Size and the MSDF renderer", () => {
    const { mesh, scene } = build({ text: "AB", size: 50, pixelScale: 3, renderer: "msdf" });
    const metadata = mesh.metadata as { text2dRenderer?: string; text2dPixelSize?: number };
    expect(metadata.text2dRenderer).toBe("bitmap");
    expect(metadata.text2dPixelSize).toBe(PIXEL_SIZE);
    const atlas = scene.textures.find((texture) => texture.name.endsWith(":bitmap-atlas"));
    expect(atlas?.samplingMode).toBe(Texture.NEAREST_SAMPLINGMODE);
    const glyphs = text2DMeshLayout(mesh)!.items.filter((item) => item.kind === "glyph");
    expect(glyphs).toHaveLength(2);
    // An 8×14 native cell at Scale 3, pens 6 native pixels apart.
    expect(glyphs[0]!.width * 100).toBeCloseTo(24);
    expect(glyphs[0]!.height * 100).toBeCloseTo(42);
    expect((glyphs[1]!.x - glyphs[0]!.x) * 100).toBeCloseTo(18);
  });

  it("puts every quad edge on a whole pixel, even centered on an odd width", () => {
    const { mesh } = build({ text: "ABC", pixelScale: 1, alignment: "center", verticalAlignment: "center" });
    for (const item of text2DMeshLayout(mesh)!.items) {
      if (item.kind !== "glyph") continue;
      const left = (item.x - item.width / 2) * 100;
      const bottom = (item.y - item.height / 2) * 100;
      expect(Math.abs(left - Math.round(left))).toBeLessThan(1e-6);
      expect(Math.abs(bottom - Math.round(bottom))).toBeLessThan(1e-6);
    }
  });

  it("rounds a Rich Text size tag to a whole Scale", () => {
    const { mesh } = build({ text: "A[size=30]B[/size]", pixelScale: 1 }, true);
    const glyphs = text2DMeshLayout(mesh)!.items.filter((item) => item.kind === "glyph");
    expect(glyphs.map((glyph) => Math.round(glyph.height * 100))).toEqual([14, 42]);
  });
});
