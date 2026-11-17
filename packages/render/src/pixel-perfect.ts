/**
 * Pixel-Perfect Mode in a 2D editor view. The view draws at device pixels (`EditorTools.setPixelPerfect`), and its
 * zoom steps through whole device pixels per texture pixel: 1, 2, 3… zoomed in and 1/2, 1/3… zoomed out, so every
 * texel covers the same whole square of device pixels at every zoom.
 */
export interface PixelPerfectSettings {
  pixelsPerUnit: number;
  /**
   * Render pixels per CSS pixel of the view: its device pixel ratio when it draws at device pixels. Zoom 1 shows one
   * texel per CSS pixel, rounded to whole device pixels.
   */
  pixelRatio?: number;
}

/**
 * Half-height of the orthographic frustum that makes one texture pixel cover `pixelsPerTexel` canvas pixels: the
 * canvas height in pixels divided by the authoring scale and that ratio, halved.
 */
export function pixelPerfectOrthoHalfHeight(
  canvasHeightPx: number,
  pixelsPerUnit: number,
  pixelsPerTexel = 1,
): number {
  if (canvasHeightPx <= 0 || pixelsPerUnit <= 0 || pixelsPerTexel <= 0) return 1;
  return canvasHeightPx / pixelsPerUnit / 2 / pixelsPerTexel;
}

/**
 * Orthographic bounds around `center` for a `width` x `height` pixel canvas at `pixelsPerTexel` canvas pixels per
 * texel, relative to the centre (as Babylon's `orthoLeft`… are). The left and bottom edges sit on whole canvas pixels
 * of the world grid, so texel edges, which lie on that grid, fall between canvas pixels wherever the camera is.
 */
export function pixelPerfectOrthoBounds(
  center: { x: number; y: number },
  canvas: { width: number; height: number },
  pixelsPerUnit: number,
  pixelsPerTexel: number,
): { left: number; right: number; bottom: number; top: number } {
  const unitsPerPixel = 1 / (pixelsPerUnit * pixelsPerTexel);
  const edge = (value: number, pixels: number) => Math.round((value - (pixels * unitsPerPixel) / 2) / unitsPerPixel) * unitsPerPixel;
  const left = edge(center.x, canvas.width) - center.x;
  const bottom = edge(center.y, canvas.height) - center.y;
  return { left, right: left + canvas.width * unitsPerPixel, bottom, top: bottom + canvas.height * unitsPerPixel };
}

/** Snap a world coordinate to the device pixel grid at the authoring scale. */
export function snapToPixelGrid(value: number, pixelsPerUnit: number): number {
  if (pixelsPerUnit <= 0) return value;
  return Math.round(value * pixelsPerUnit) / pixelsPerUnit;
}
