import type { PixelFontLine } from "@haptic/render";

/** The Font editor's pixel preview Scales for the waterfall: whole multiples of the Pixel Size. */
export const PIXEL_PREVIEW_WATERFALL_SCALES = [1, 2, 3, 4] as const;

/** The largest Scale the Font editor's pixel sample takes. */
export const MAX_PIXEL_PREVIEW_SCALE = 16;

/**
 * Device pixels per font pixel at a preview Scale: a whole number, so every font pixel covers the same block of
 * device pixels. On a fractional device pixel ratio this rounds the Scale to the nearest whole block.
 */
export function pixelPreviewTexelSize(scale: number, devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(1, Math.round(Math.max(1, scale) * ratio));
}

/** The glyph sheet's Scale: as large as fits a 24 px cell, at least 1. */
export function pixelPreviewGlyphScale(pixelSize: number): number {
  return Math.max(1, Math.floor(24 / Math.max(1, pixelSize)));
}

/** `line` as white RGBA with each drawn font pixel a `texel` × `texel` opaque block. */
export function pixelFontLineRgba(line: PixelFontLine, texel: number): { width: number; height: number; rgba: Uint8ClampedArray } {
  const size = Math.max(1, Math.floor(texel));
  const width = line.width * size;
  const height = line.height * size;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < line.height; y++) {
    for (let x = 0; x < line.width; x++) {
      if (!line.alpha[y * line.width + x]) continue;
      for (let dy = 0; dy < size; dy++) {
        const row = (y * size + dy) * width;
        for (let dx = 0; dx < size; dx++) rgba.fill(255, (row + x * size + dx) * 4, (row + x * size + dx) * 4 + 4);
      }
    }
  }
  return { width, height, rgba };
}
