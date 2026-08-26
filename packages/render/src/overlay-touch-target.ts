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

/** Overlay ortho canvas CSS pixels → world XY (Y up, matching the height-9 frustum). */
export function overlayCanvasToWorld(
  canvasX: number,
  canvasY: number,
  renderWidth: number,
  renderHeight: number,
  orthoHalfHeight: number,
): { x: number; y: number } {
  const width = Math.max(1, renderWidth);
  const height = Math.max(1, renderHeight);
  const aspect = width / height;
  const ndcX = (canvasX / width) * 2 - 1;
  const ndcY = 1 - (canvasY / height) * 2;
  return {
    x: ndcX * orthoHalfHeight * aspect,
    y: ndcY * orthoHalfHeight,
  };
}
