/** Editor pinch and wheel zoom stay continuous; there are no integer zoom steps. */
export interface PixelPerfectSettings {
  pixelsPerUnit: number;
}

/**
 * Half-height of the orthographic frustum that makes one texture pixel cover
 * exactly one device pixel: the canvas height in pixels divided by the
 * authoring scale, halved.
 */
export function pixelPerfectOrthoHalfHeight(
  canvasHeightPx: number,
  pixelsPerUnit: number,
  zoom = 1,
): number {
  if (canvasHeightPx <= 0 || pixelsPerUnit <= 0 || zoom <= 0) return 1;
  return canvasHeightPx / pixelsPerUnit / 2 / zoom;
}

/** Snap a world coordinate to the device pixel grid at the authoring scale. */
export function snapToPixelGrid(value: number, pixelsPerUnit: number): number {
  if (pixelsPerUnit <= 0) return value;
  return Math.round(value * pixelsPerUnit) / pixelsPerUnit;
}
