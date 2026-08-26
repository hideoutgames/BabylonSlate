import { describe, expect, it } from "vitest";
import type { RichTextStyle } from "@babylonslate/core";
import {
  bitmapGlyphKey,
  packBitmapGlyphAtlas,
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

  it("falls back to the 5x7 bitmap when canvas paints a solid rectangle", () => {
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document: unknown }).document = {
      createElement: () => ({
        width: 1,
        height: 1,
        getContext() {
          return {
            font: "",
            textBaseline: "top",
            textAlign: "left",
            fillStyle: "",
            strokeStyle: "",
            lineJoin: "",
            miterLimit: 0,
            lineWidth: 0,
            measureText: () => ({
              width: 16,
              actualBoundingBoxAscent: 16,
              actualBoundingBoxDescent: 4,
            }),
            clearRect() {},
            fillText() {},
            strokeText() {},
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              const data = new Uint8ClampedArray(w * h * 4);
              data.fill(255);
              return { data };
            },
          };
        },
      }),
    };
    try {
      const cell = rasterizeBitmapGlyph("A", STYLE);
      const opaque = opaqueCount(cell.pixels);
      const total = cell.width * cell.height;
      expect(opaque).toBeGreaterThan(0);
      expect(opaque).toBeLessThan(total * 0.9);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        (globalThis as { document: unknown }).document = previous;
      }
    }
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
