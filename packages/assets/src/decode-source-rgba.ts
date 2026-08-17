import { clampDimension } from "./texture-compression";

export interface DecodedRgbaImage {
  rgba: Uint8Array;
  width: number;
  height: number;
  clamped: boolean;
}

interface DrawableImage {
  width: number;
  height: number;
  source: ImageBitmap;
  close?: () => void;
}

type HtmlImageCtor = new () => {
  width: number;
  height: number;
  src: string;
  decode: () => Promise<void>;
};

/**
 * Decode image bytes to RGBA8, clamping longest edge to maxDimension.
 * Prefers createImageBitmap; falls back to Image.decode() (Safari / odd MIME).
 */
export async function decodeSourceToRgba(
  source: Uint8Array,
  maxDimension: number,
  mime?: string,
): Promise<DecodedRgbaImage> {
  const copy = source.slice();
  const blob = new Blob([copy], mime ? { type: mime } : undefined);
  const drawable = await decodeToDrawable(blob);
  try {
    return rasterizeDrawable(drawable, maxDimension);
  } finally {
    drawable.close?.();
  }
}

function htmlImageCtor(): HtmlImageCtor | undefined {
  const ctor = (globalThis as { Image?: HtmlImageCtor }).Image;
  return typeof ctor === "function" ? ctor : undefined;
}

async function decodeToDrawable(blob: Blob): Promise<DrawableImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close(),
      };
    } catch (error) {
      if (!htmlImageCtor()) throw error;
      try {
        return await decodeWithHtmlImage(blob);
      } catch {
        throw error;
      }
    }
  }
  return decodeWithHtmlImage(blob);
}

async function decodeWithHtmlImage(blob: Blob): Promise<DrawableImage> {
  const ImageCtor = htmlImageCtor();
  if (!ImageCtor) {
    throw new Error("createImageBitmap is required for texture encode decode");
  }
  const url = URL.createObjectURL(blob);
  const image = new ImageCtor();
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    width: image.width,
    height: image.height,
    source: image as unknown as ImageBitmap,
    close: () => URL.revokeObjectURL(url),
  };
}

function rasterizeDrawable(
  drawable: DrawableImage,
  maxDimension: number,
): DecodedRgbaImage {
  const { width, height, clamped } = clampDimension(
    drawable.width,
    drawable.height,
    maxDimension,
  );
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas is required for Worker encode path");
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for texture encode");
  ctx.drawImage(drawable.source, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    rgba: new Uint8Array(imageData.data.buffer.slice(0)),
    width,
    height,
    clamped,
  };
}
