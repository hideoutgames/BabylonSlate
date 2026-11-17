import { wholePixelScale } from "@haptic/core";

/**
 * Pixel-Perfect Mode in a 2D editor view. The view draws at device pixels (`EditorTools.setPixelPerfect`) and zooms
 * smoothly; near a whole number of device pixels per texture pixel (1, 2, 3… zoomed in, 1/2, 1/3… zoomed out) it
 * settles on that level (`pixelZoomDetent`), where every texel covers the same whole square of device pixels.
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
 * How close, as a fraction of the level, a zoom must come to a whole level to settle on it: a little over half a wheel
 * step (10%), so a wheel lands on a level about every other pass and one step always leaves it.
 */
export const PIXEL_ZOOM_DETENT = 0.06;

/**
 * The scale a pixel-perfect view shows for a continuous `scale`: the whole level nearest it (`wholePixelScale`) while
 * within `band` of that level, else `scale` itself. Only the shown scale settles: the zoom gestures keep moving the
 * continuous one, so a slow wheel or pinch leaves a level as soon as it passes the band.
 */
export function pixelZoomDetent(scale: number, band = PIXEL_ZOOM_DETENT): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 1;
  const level = wholePixelScale(scale);
  return Math.abs(scale / level - 1) <= band ? level : scale;
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
