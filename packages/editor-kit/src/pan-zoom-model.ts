/**
 * A 2D view onto flat content (an image, an artboard): `scale` surface pixels
 * per content unit, and `x`/`y` the surface position of the content's origin.
 */
export interface PanZoomView {
  scale: number;
  x: number;
  y: number;
}

export interface PanZoomLimits {
  minScale: number;
  maxScale: number;
}

export interface PanZoomSize {
  width: number;
  height: number;
}

export const DEFAULT_PAN_ZOOM_LIMITS: PanZoomLimits = { minScale: 0.02, maxScale: 64 };

const clampScale = (scale: number, limits: PanZoomLimits) =>
  Math.min(limits.maxScale, Math.max(limits.minScale, scale));

/** Content centred in the surface at `scale`. */
export function centeredView(content: PanZoomSize, surface: PanZoomSize, scale: number): PanZoomView {
  return {
    scale,
    x: (surface.width - content.width * scale) / 2,
    y: (surface.height - content.height * scale) / 2,
  };
}

/** The scale that fits content inside the surface less `inset` on each side; 1 when either is empty. */
export function fitScale(content: PanZoomSize, surface: PanZoomSize, inset = 0): number {
  const width = surface.width - inset * 2;
  const height = surface.height - inset * 2;
  if (content.width <= 0 || content.height <= 0 || width <= 0 || height <= 0) return 1;
  return Math.min(width / content.width, height / content.height);
}

/** Zooms by `factor` keeping the content point under the surface `pivot` where it is. */
export function zoomViewAbout(
  view: PanZoomView,
  factor: number,
  pivot: { x: number; y: number },
  limits: PanZoomLimits = DEFAULT_PAN_ZOOM_LIMITS,
): PanZoomView {
  if (!(factor > 0)) return view;
  const scale = clampScale(view.scale * factor, limits);
  const ratio = scale / view.scale;
  return {
    scale,
    x: pivot.x - (pivot.x - view.x) * ratio,
    y: pivot.y - (pivot.y - view.y) * ratio,
  };
}

export function panView(view: PanZoomView, dx: number, dy: number): PanZoomView {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** The two-finger-down state a pinch is measured from, so pinch zoom is absolute. */
export interface PinchOrigin {
  view: PanZoomView;
  mid: { x: number; y: number };
  spread: number;
}

/** Zooms about the starting midpoint by the spread ratio, then follows the midpoint. */
export function pinchView(
  origin: PinchOrigin,
  mid: { x: number; y: number },
  spread: number,
  limits: PanZoomLimits = DEFAULT_PAN_ZOOM_LIMITS,
): PanZoomView {
  const zoomed = zoomViewAbout(origin.view, spread / Math.max(1, origin.spread), origin.mid, limits);
  return panView(zoomed, mid.x - origin.mid.x, mid.y - origin.mid.y);
}

/** Surface point → content coordinates. */
export function viewToContent(view: PanZoomView, point: { x: number; y: number }) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

/** Content coordinates → surface point. */
export function contentToView(view: PanZoomView, point: { x: number; y: number }) {
  return { x: view.x + point.x * view.scale, y: view.y + point.y * view.scale };
}
