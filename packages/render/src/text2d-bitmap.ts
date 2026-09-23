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
  workingBytes: number;
};

export type BitmapAllocationLimits = {
  maxTextureSize: number;
  maxWorkingBytes: number;
  /** The representation that remains usable until this replacement commits. */
  retainedBytes?: number;
};

export const DEFAULT_BITMAP_WORKING_BYTES = 64 * 1024 * 1024;
const defaultLimits: BitmapAllocationLimits = {
  maxTextureSize: 8192,
  maxWorkingBytes: DEFAULT_BITMAP_WORKING_BYTES,
};

export class BitmapAllocationLimitError extends Error {
  readonly code = "text.bitmap_allocation_limit";
  constructor(detail: string) {
    super(`Bitmap text allocation limit: ${detail}`);
    this.name = "BitmapAllocationLimitError";
  }
}

type GlyphSize = { key: string; width: number; height: number };
export type BitmapGlyphMeasurement = GlyphSize & { layoutWidth: number; layoutHeight: number };
export type BitmapAtlasPlan = {
  width: number;
  height: number;
  workingBytes: number;
  placed: Array<GlyphSize & { x: number; y: number }>;
};

function checkedCellBytes(width: number, height: number, limits: BitmapAllocationLimits): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    width > limits.maxTextureSize || height > limits.maxTextureSize) {
    throw new BitmapAllocationLimitError(`cell ${width} × ${height} exceeds supported dimensions.`);
  }
  const bytes = width * height * 4;
  if (!Number.isSafeInteger(bytes) || bytes > limits.maxWorkingBytes) {
    throw new BitmapAllocationLimitError("cell byte count exceeds the working-set budget.");
  }
  return bytes;
}

/** Compute bounds and budget before any glyph or atlas pixel allocation. */
export function planBitmapGlyphAtlas(
  cells: readonly GlyphSize[],
  limits: BitmapAllocationLimits = defaultLimits,
): BitmapAtlasPlan | null {
  if (!cells.length) return null;
  const retained = limits.retainedBytes ?? 0;
  if (!Number.isSafeInteger(limits.maxTextureSize) || limits.maxTextureSize < 8 ||
    !Number.isSafeInteger(limits.maxWorkingBytes) || limits.maxWorkingBytes <= 0 ||
    !Number.isSafeInteger(retained) || retained < 0) {
    throw new BitmapAllocationLimitError("invalid dimensions or working-set budget.");
  }
  let cellBytes = 0;
  let largestCell = 0;
  let minWidth = 8;
  for (const cell of cells) {
    const bytes = checkedCellBytes(cell.width, cell.height, limits);
    cellBytes += bytes;
    largestCell = Math.max(largestCell, bytes);
    minWidth = Math.max(minWidth, cell.width + 2);
    if (!Number.isSafeInteger(cellBytes) || cellBytes + retained > limits.maxWorkingBytes) {
      throw new BitmapAllocationLimitError("unique glyph cells exceed the working-set budget.");
    }
  }
  let best: BitmapAtlasPlan | null = null;
  for (let width = nextPowerOfTwo(minWidth); width <= limits.maxTextureSize; width *= 2) {
    let x = 1, y = 1, rowHeight = 0;
    const placed: BitmapAtlasPlan["placed"] = [];
    for (const cell of cells) {
      if (x + cell.width + 1 > width) {
        x = 1;
        y += rowHeight + 1;
        rowHeight = 0;
      }
      placed.push({ ...cell, x, y });
      x += cell.width + 1;
      rowHeight = Math.max(rowHeight, cell.height);
    }
    const height = nextPowerOfTwo(y + rowHeight + 1);
    if (height > limits.maxTextureSize) continue;
    const atlasBytes = width * height * 4;
    if (!Number.isSafeInteger(atlasBytes) || atlasBytes > limits.maxWorkingBytes) continue;
    // Unique cells + canvas/readback staging + CPU/GPU atlas + still-live old text.
    const workingBytes = cellBytes + 2 * largestCell + 2 * atlasBytes + retained;
    if (!Number.isSafeInteger(workingBytes) || workingBytes > limits.maxWorkingBytes) continue;
    if (!best || width * height < best.width * best.height ||
      (width * height === best.width * best.height && Math.abs(width - height) < Math.abs(best.width - best.height))) {
      best = { width, height, placed, workingBytes };
    }
  }
  if (!best) throw new BitmapAllocationLimitError("single atlas cannot fit the texture dimensions and working-set budget.");
  return best;
}

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

function isLetterShapedAlpha(pixels: Uint8ClampedArray, width: number, height: number): boolean {
  const total = width * height;
  if (total <= 0) return false;
  let opaque = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) <= 8) continue;
      opaque += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (opaque === 0 || opaque >= total * 0.9) return false;
  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const solid = opaque >= bboxW * bboxH * 0.95;
  const thin = bboxW < width * 0.45 || bboxH < height * 0.45;
  return !(solid && !thin);
}

function nextPowerOfTwo(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER / 2) {
    throw new BitmapAllocationLimitError("invalid atlas dimension.");
  }
  let size = 8;
  while (size < value) size *= 2;
  return size;
}

function softwareGlyphSize(style: RichTextStyle) {
  const scale = Math.max(1, Math.round(style.size / ASCII_BITMAP_ROWS));
  const outlinePx = Math.max(0, Math.round(style.outline));
  return {
    width: ASCII_BITMAP_COLS * scale + (style.bold ? scale : 0) + outlinePx * 2 + 2,
    height: ASCII_BITMAP_ROWS * scale + outlinePx * 2 + 2,
  };
}

function canvasGlyphSize(ctx: CanvasRenderingContext2D, ch: string, style: RichTextStyle) {
  const measured = ctx.measureText(ch);
  const pad = Math.max(2, Math.ceil(style.outline) + 1);
  const ascent = measured.actualBoundingBoxAscent > 0 ? measured.actualBoundingBoxAscent : style.size * 0.8;
  const descent = measured.actualBoundingBoxDescent > 0 ? measured.actualBoundingBoxDescent : style.size * 0.25;
  return {
    width: Math.max(1, Math.ceil((measured.width || style.size * 0.5) + pad * 2)),
    height: Math.max(1, Math.ceil(ascent + descent + pad * 2)),
    pad,
  };
}

/** Measure both native text and fallback bounds without painting either. */
export function measureBitmapGlyph(ch: string, style: RichTextStyle, stack = DEFAULT_TEXT2D_FONT_STACK): BitmapGlyphMeasurement {
  const software = softwareGlyphSize(style);
  let layout = software;
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = cssFontForText2D(style, stack);
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      layout = canvasGlyphSize(ctx, ch, style);
    }
  }
  return {
    key: bitmapGlyphKey(ch, style, stack),
    width: Math.max(layout.width, software.width),
    height: Math.max(layout.height, software.height),
    layoutWidth: layout.width,
    layoutHeight: layout.height,
  };
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
  limits: BitmapAllocationLimits,
  expected: BitmapGlyphMeasurement,
): BitmapGlyphCell | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const font = cssFontForText2D(style, stack);
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const { width, height, pad } = canvasGlyphSize(ctx, ch, style);
  checkedCellBytes(width, height, limits);
  if (width > expected.width || height > expected.height) {
    throw new BitmapAllocationLimitError("font metrics changed after allocation preflight.");
  }
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
  if (!isLetterShapedAlpha(image.data, width, height)) return null;
  return { key, width, height, pixels: image.data };
}

/** Rasterize one glyph: canvas FontFace when it paints, else bundled 5×7. */
export function rasterizeBitmapGlyph(
  ch: string,
  style: RichTextStyle,
  stack = DEFAULT_TEXT2D_FONT_STACK,
  limits: BitmapAllocationLimits = defaultLimits,
  measurement?: BitmapGlyphMeasurement,
): BitmapGlyphCell {
  const measured = measurement ?? measureBitmapGlyph(ch, style, stack);
  planBitmapGlyphAtlas([measured], limits);
  const key = bitmapGlyphKey(ch, style, stack);
  return (
    tryCanvasRasterize(ch, style, stack, key, limits, measured) ??
    rasterizeSoftwareBitmapGlyph(ch, style, key)
  );
}

/** Shelf-pack unique glyph cells onto a power-of-two RGBA atlas. */
export function packBitmapGlyphAtlas(
  cells: readonly BitmapGlyphCell[],
  limits: BitmapAllocationLimits = defaultLimits,
  preparedPlan?: BitmapAtlasPlan | null,
): PackedBitmapGlyphAtlas | null {
  if (cells.length === 0) return null;
  const plan = preparedPlan ?? planBitmapGlyphAtlas(cells, limits)!;
  const atlasW = plan.width;
  const atlasH = plan.height;
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));
  for (const place of plan.placed) {
    const cell = byKey.get(place.key);
    if (!cell || cell.width > place.width || cell.height > place.height ||
      cell.pixels.length !== checkedCellBytes(cell.width, cell.height, limits)) {
      throw new BitmapAllocationLimitError("glyph changed after allocation preflight.");
    }
  }
  const pixels = new Uint8Array(atlasW * atlasH * 4);
  const uvs = new Map<string, { u0: number; v0: number; u1: number; v1: number }>();
  for (const { key, x: px, y: py } of plan.placed) {
    const cell = byKey.get(key)!;
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
  return { width: atlasW, height: atlasH, pixels, uvs, workingBytes: plan.workingBytes };
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
