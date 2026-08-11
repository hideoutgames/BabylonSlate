import { clampDimension } from "./texture-compression";

export interface DecodedRgbaImage {
  rgba: Uint8Array;
  width: number;
  height: number;
  clamped: boolean;
}

/**
 * Decode image bytes to RGBA8, clamping longest edge to maxDimension.
 * Uses createImageBitmap + OffscreenCanvas when available (Worker / modern browsers).
 */
export async function decodeSourceToRgba(
  source: Uint8Array,
  maxDimension: number,
): Promise<DecodedRgbaImage> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is required for texture encode decode");
  }
  const copy = source.slice();
  const blob = new Blob([copy]);
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height, clamped } = clampDimension(
      bitmap.width,
      bitmap.height,
      maxDimension,
    );
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : (() => {
            throw new Error("OffscreenCanvas is required for Worker encode path");
          })();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable for texture encode");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return {
      rgba: new Uint8Array(imageData.data.buffer.slice(0)),
      width,
      height,
      clamped,
    };
  } finally {
    bitmap.close();
  }
}
