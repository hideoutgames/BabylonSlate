/** Overlay 2DButton pick floor in world units from Engine Settings `touchMinTargetPx`. */
export function overlayMinTargetWorldSize(
  minPx: number,
  canvasCssHeight: number,
  frustumHeight: number,
): number {
  if (!(minPx > 0) || !(canvasCssHeight > 0) || !(frustumHeight > 0)) {
    return 0;
  }
  return (minPx / canvasCssHeight) * frustumHeight;
}

/**
 * Point-in-AABB with a screen-space min size applied in world units.
 * Inflates half-extents out to `minWorld / 2`; never shrinks a larger visual.
 */
export function pointInInflatedWorldAabb(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  halfW: number,
  halfH: number,
  minWorld: number,
): boolean {
  const floor = minWorld > 0 ? minWorld / 2 : 0;
  const hw = Math.max(Math.abs(halfW), floor);
  const hh = Math.max(Math.abs(halfH), floor);
  return Math.abs(x - centerX) <= hw && Math.abs(y - centerY) <= hh;
}
