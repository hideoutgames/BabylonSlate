/**
 * Samples of the image a view presented, for checks that cannot see the screen (the Feature Test Check on a device).
 * The element the player sees is drawn down into a small 2D canvas in the task that presented it, while the WebGL
 * drawing buffer (with or without preserveDrawingBuffer) and the WebGPU canvas texture still hold the frame.
 */

/** A pixel is near-black when its brightest channel, weighted by its alpha, is at most this (of 255). */
export const PRESENTED_IMAGE_BLACK_LEVEL = 12;

/** The downsampled image's longer edge, in pixels. */
const SAMPLE_EDGE = 64;

export type PresentedImageSample = {
  /** Share of the downsampled image's pixels that are near-black (`PRESENTED_IMAGE_BLACK_LEVEL`), 0 to 1. */
  blackShare: number;
  /** Mean brightest channel weighted by alpha, 0 to 255. */
  meanLevel: number;
  width: number;
  height: number;
};

/**
 * Summarises unpremultiplied RGBA bytes (as `getImageData` returns them). A transparent pixel counts as black: the
 * canvas shows nothing of the frame there.
 */
export function summarizePresentedPixels(rgba: ArrayLike<number>, width: number, height: number): PresentedImageSample {
  const count = width * height;
  let black = 0;
  let sum = 0;
  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * 4;
    const level = (Math.max(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!) * rgba[offset + 3]!) / 255;
    if (level <= PRESENTED_IMAGE_BLACK_LEVEL) black += 1;
    sum += level;
  }
  return { blackShare: count ? black / count : 1, meanLevel: count ? sum / count : 0, width, height };
}

/** Downsamples `source` as it is presented now; null when it has no pixels or no 2D context can read it. */
export function samplePresentedImage(source: HTMLCanvasElement | OffscreenCanvas): PresentedImageSample | null {
  const { width, height } = source;
  if (!width || !height) return null;
  const scale = SAMPLE_EDGE / Math.max(width, height);
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const target = typeof OffscreenCanvas === "undefined"
    ? Object.assign(document.createElement("canvas"), { width: sampleWidth, height: sampleHeight })
    : new OffscreenCanvas(sampleWidth, sampleHeight);
  const context = target.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) return null;
  context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
  return summarizePresentedPixels(context.getImageData(0, 0, sampleWidth, sampleHeight).data, sampleWidth, sampleHeight);
}
