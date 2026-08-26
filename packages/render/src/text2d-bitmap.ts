import type { RichTextStyle } from "@babylonslate/core";
import {
  ASCII_BITMAP_COLS,
  ASCII_BITMAP_ROWS,
  asciiBitmapRows,
} from "./default-typeface";

export type BitmapGlyphCell = {
  key: string;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

export type PackedBitmapGlyphAtlas = {
  width: number;
  height: number;
  pixels: Uint8Array;
  uvs: Map<string, { u0: number; v0: number; u1: number; v1: number }>;
};

export const DEFAULT_TEXT2D_FONT_STACK = "sans-serif";

export function cssFontForText2D(style: RichTextStyle, stack: string): string {
  const italic = style.italic ? "italic" : "normal";
  const weight = style.bold ? "700" : "400";
  const size = Math.max(1, Math.round(style.size));
  const family = stack.trim() || DEFAULT_TEXT2D_FONT_STACK;
  return `${italic} ${weight} ${size}px ${family}`;
}

export function bitmapGlyphKey(
  ch: string,
  style: RichTextStyle,
  stack: string,
): string {
  return [
    ch,
    Math.round(style.size),
    style.bold ? "1" : "0",
    style.italic ? "1" : "0",
    Math.round(style.outline * 10) / 10,
    style.color.map((c) => Math.round(c * 255)).join(","),
    style.outlineColor.map((c) => Math.round(c * 255)).join(","),
    stack,
  ].join("|");
}

function cssRgb(color: [number, number, number]): string {
  return `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`;
}

function channel(color: [number, number, number], index: number): number {
  return Math.max(0, Math.min(255, Math.round(color[index]! * 255)));
}

function hasOpaquePixel(pixels: Uint8ClampedArray): boolean {
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 8) return true;
  }
  return false;
}

function nextPowerOfTwo(value: number): number {
  let size = 8;
  while (size < value) size *= 2;
  return size;
}

function rasterizeSoftwareBitmapGlyph(
  ch: string,
  style: RichTextStyle,
  key: string,
): BitmapGlyphCell {
  const scale = Math.max(1, Math.round(style.size / ASCII_BITMAP_ROWS));
  const outlinePx = Math.max(0, Math.round(style.outline));
  const boldExtra = style.bold ? scale : 0;
  const width =
    ASCII_BITMAP_COLS * scale + boldExtra + outlinePx * 2 + 2;
  const height = ASCII_BITMAP_ROWS * scale + outlinePx * 2 + 2;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const rows = asciiBitmapRows(ch);
  const paint = (
    col: number,
    row: number,
    color: [number, number, number],
    alpha: number,
  ) => {
    const x0 = outlinePx + 1 + col * scale;
    const y0 = outlinePx + 1 + row * scale;
    for (let y = 0; y < scale; y++) {
      for (let x = 0; x < scale; x++) {
        const px = x0 + x;
        const py = y0 + y;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const i = (py * width + px) * 4;
        pixels[i] = channel(color, 0);
        pixels[i + 1] = channel(color, 1);
        pixels[i + 2] = channel(color, 2);
        pixels[i + 3] = alpha;
      }
    }
  };
  const lit = (col: number, row: number, shift: number): boolean => {
    const bit = col - shift;
    if (bit < 0 || bit >= ASCII_BITMAP_COLS) return false;
    return (((rows[row] ?? 0) >> (ASCII_BITMAP_COLS - 1 - bit)) & 1) === 1;
  };
  if (outlinePx > 0) {
    for (let row = 0; row < ASCII_BITMAP_ROWS; row++) {
      for (let col = 0; col < ASCII_BITMAP_COLS + (style.bold ? 1 : 0); col++) {
        if (!lit(col, row, 0) && !(style.bold && lit(col, row, 1))) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            paint(col + dx, row + dy, style.outlineColor, 255);
          }
        }
      }
    }
  }
  for (let row = 0; row < ASCII_BITMAP_ROWS; row++) {
    for (let col = 0; col < ASCII_BITMAP_COLS; col++) {
      if (lit(col, row, 0)) paint(col, row, style.color, 255);
      if (style.bold && lit(col, row, 1)) paint(col, row, style.color, 255);
    }
  }
  return { key, width, height, pixels };
}

function tryCanvasRasterize(
  ch: string,
  style: RichTextStyle,
  stack: string,
  key: string,
): BitmapGlyphCell | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const font = cssFontForText2D(style, stack);
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const measured = ctx.measureText(ch);
  const pad = Math.max(2, Math.ceil(style.outline) + 1);
  const ascent =
    measured.actualBoundingBoxAscent > 0
      ? measured.actualBoundingBoxAscent
      : style.size * 0.8;
  const descent =
    measured.actualBoundingBoxDescent > 0
      ? measured.actualBoundingBoxDescent
      : style.size * 0.25;
  const width = Math.max(1, Math.ceil((measured.width || style.size * 0.5) + pad * 2));
  const height = Math.max(1, Math.ceil(ascent + descent + pad * 2));
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const x = pad;
  const y = pad;
  if (style.outline > 0) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = cssRgb(style.outlineColor);
    ctx.lineWidth = Math.max(1, style.outline * 2);
    ctx.strokeText(ch, x, y);
  }
  ctx.fillStyle = cssRgb(style.color);
  ctx.fillText(ch, x, y);
  const image = ctx.getImageData(0, 0, width, height);
  if (!hasOpaquePixel(image.data)) return null;
  return { key, width, height, pixels: image.data };
}

/** Rasterize one glyph: canvas FontFace when it paints, else bundled 5×7. */
export function rasterizeBitmapGlyph(
  ch: string,
  style: RichTextStyle,
  stack = DEFAULT_TEXT2D_FONT_STACK,
): BitmapGlyphCell {
  const key = bitmapGlyphKey(ch, style, stack);
  return (
    tryCanvasRasterize(ch, style, stack, key) ??
    rasterizeSoftwareBitmapGlyph(ch, style, key)
  );
}

/** Shelf-pack unique glyph cells onto a power-of-two RGBA atlas. */
export function packBitmapGlyphAtlas(
  cells: readonly BitmapGlyphCell[],
): PackedBitmapGlyphAtlas | null {
  if (cells.length === 0) return null;
  const pad = 1;
  let atlasW = 32;
  const maxCellW = Math.max(...cells.map((cell) => cell.width));
  while (atlasW < maxCellW + pad * 2) atlasW *= 2;
  let x = pad;
  let y = pad;
  let rowH = 0;
  const placed: Array<{ cell: BitmapGlyphCell; x: number; y: number }> = [];
  for (const cell of cells) {
    if (x + cell.width + pad > atlasW) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    placed.push({ cell, x, y });
    x += cell.width + pad;
    rowH = Math.max(rowH, cell.height);
  }
  const atlasH = nextPowerOfTwo(y + rowH + pad);
  const pixels = new Uint8Array(atlasW * atlasH * 4);
  const uvs = new Map<string, { u0: number; v0: number; u1: number; v1: number }>();
  for (const { cell, x: px, y: py } of placed) {
    for (let row = 0; row < cell.height; row++) {
      const src = row * cell.width * 4;
      const dst = ((py + row) * atlasW + px) * 4;
      pixels.set(cell.pixels.subarray(src, src + cell.width * 4), dst);
    }
    uvs.set(cell.key, {
      u0: px / atlasW,
      v0: 1 - (py + cell.height) / atlasH,
      u1: (px + cell.width) / atlasW,
      v1: 1 - py / atlasH,
    });
  }
  return { width: atlasW, height: atlasH, pixels, uvs };
}

export function resolveText2DFontStack(
  fontGuid: string | null,
  assets?: {
    fontCssStack?: string;
    fontCssStackByGuid?: ReadonlyMap<string, string>;
  },
): string {
  if (fontGuid) {
    const named = assets?.fontCssStackByGuid?.get(fontGuid);
    if (named && named.trim()) return named;
  }
  const fallback = assets?.fontCssStack?.trim();
  return fallback || DEFAULT_TEXT2D_FONT_STACK;
}
