import {
  designScale,
  type ScaleRule,
  type WidgetLayout,
} from "@babylonslate/ui-runtime";

export const UI_DESIGN_ZOOM_MIN = 0.25;
export const UI_DESIGN_ZOOM_MAX = 8;

export type DesignView = {
  zoom: number;
  panX: number;
  panY: number;
};

export type PointerPoint = { x: number; y: number };

/** Stroke merge key so one undo restores the whole widget-drag gesture. */
export function uiDesignStrokeMergeKey(strokeId: string): string {
  return `ui-design-stroke:${strokeId}`;
}

export function clampDesignZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(UI_DESIGN_ZOOM_MAX, Math.max(UI_DESIGN_ZOOM_MIN, zoom));
}

/** Screen → authored design pixels, including project ADT ideal scale. */
export function designerLayoutViewScale(options: {
  previewScale: number;
  zoom: number;
  bitmapScale?: number;
  bitmap: { width: number; height: number };
  designResolution: { width: number; height: number };
  scaleRule: ScaleRule;
}): number {
  const adtScale = designScale(
    options.bitmap,
    options.designResolution,
    options.scaleRule,
  );
  const bitmapScale = options.bitmapScale ?? 1;
  return options.previewScale * options.zoom * bitmapScale * adtScale;
}

/** Screen Y-down to layout Y-down (Babylon GUI). */
export function canvasDeltaToLayoutDelta(
  screenDelta: PointerPoint,
  viewScale: number,
): PointerPoint {
  const scale =
    !Number.isFinite(viewScale) || viewScale === 0 ? 1 : viewScale;
  return {
    x: screenDelta.x / scale,
    y: screenDelta.y / scale,
  };
}

/** Translate a widget in parent space without changing alignment or size. */
export function applyWidgetDragOffset(
  layout: WidgetLayout,
  delta: PointerPoint,
  parent?: { width: number; height: number },
): WidgetLayout {
  const leftDelta =
    layout.leftUnit === "percent" && parent && parent.width > 0
      ? (delta.x / parent.width) * 100
      : delta.x;
  const topDelta =
    layout.topUnit === "percent" && parent && parent.height > 0
      ? (delta.y / parent.height) * 100
      : delta.y;
  return {
    ...layout,
    left: layout.left + leftDelta,
    top: layout.top + topDelta,
  };
}

/** Keep the canvas point under `pointer` (viewport-local) stable. */
export function zoomAtPoint(
  current: DesignView,
  nextZoom: number,
  pointer: PointerPoint,
): DesignView {
  const zoom = clampDesignZoom(nextZoom);
  const from = current.zoom === 0 || !Number.isFinite(current.zoom) ? 1 : current.zoom;
  const ratio = zoom / from;
  return {
    zoom,
    panX: pointer.x - (pointer.x - current.panX) * ratio,
    panY: pointer.y - (pointer.y - current.panY) * ratio,
  };
}

export function pointerCentroid(
  pointers: ReadonlyMap<number, PointerPoint>,
): PointerPoint {
  let x = 0;
  let y = 0;
  for (const point of pointers.values()) {
    x += point.x;
    y += point.y;
  }
  const count = Math.max(1, pointers.size);
  return { x: x / count, y: y / count };
}

export function pointerSpan(
  pointers: ReadonlyMap<number, PointerPoint>,
): number {
  const points = [...pointers.values()];
  if (points.length < 2) return 0;
  const a = points[0]!;
  const b = points[1]!;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export const UI_DESIGN_DRAG_THRESHOLD_PX = 4;
export const UI_DESIGN_HANDLE_HIT_SIZE_PX = 44;
export const UI_DESIGN_HANDLE_VISUAL_SIZE_PX = 14;
export const UI_DESIGN_HANDLE_SIZE_PX = UI_DESIGN_HANDLE_VISUAL_SIZE_PX;
export const UI_DESIGN_FIT_PADDING_PX = 24;

/** Fit once per device canvas, not when the Design dock resizes. */
export function uiDesignerCanvasFitKey(
  presetId: string,
  canvas: { width: number; height: number },
): string {
  return `${presetId}:${canvas.width}x${canvas.height}`;
}

export function previewScaleToFit(
  viewport: { width: number; height: number },
  canvas: { width: number; height: number },
  padding = UI_DESIGN_FIT_PADDING_PX,
): number {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const availW = viewport.width - padding * 2;
  const availH = viewport.height - padding * 2;
  if (availW <= 0 || availH <= 0) {
    return Math.min(1, 640 / width);
  }
  return Math.min(1, availW / width, availH / height);
}

export function centeredFitView(
  viewport: { width: number; height: number },
  canvas: { width: number; height: number },
  padding = UI_DESIGN_FIT_PADDING_PX,
): { previewScale: number; view: DesignView } {
  const previewScale = previewScaleToFit(viewport, canvas, padding);
  const width = canvas.width * previewScale;
  const height = canvas.height * previewScale;
  return {
    previewScale,
    view: {
      zoom: 1,
      panX: (viewport.width - width) / 2,
      panY: (viewport.height - height) / 2,
    },
  };
}

export function passedDragThreshold(
  start: PointerPoint,
  current: PointerPoint,
  threshold = UI_DESIGN_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

export type ScreenRect = { x: number; y: number; width: number; height: number };

/** Map a design-space GUI rect into viewport pixels (CSS transform of the canvas). */
export function designRectToScreen(
  guiRect: ScreenRect,
  view: DesignView,
  previewScale: number,
): ScreenRect {
  const scale = previewScale * view.zoom;
  return {
    x: view.panX + guiRect.x * scale,
    y: view.panY + guiRect.y * scale,
    width: guiRect.width * scale,
    height: guiRect.height * scale,
  };
}

export type HandleEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Scale design-space rects onto the ADT bitmap (origin-aligned, no letterbox). */
export function designRectToBitmap(
  rect: ScreenRect,
  bitmapScale: number,
): ScreenRect {
  const scale =
    !Number.isFinite(bitmapScale) || bitmapScale === 0 ? 1 : bitmapScale;
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Transform center is Babylon 0–1 in Y-down GUI space. */
export function pivotToScreen(
  guiRect: ScreenRect,
  transformCenter: { x: number; y: number },
  view: DesignView,
  previewScale: number,
): PointerPoint {
  const screen = designRectToScreen(guiRect, view, previewScale);
  return {
    x: screen.x + screen.width * transformCenter.x,
    y: screen.y + screen.height * transformCenter.y,
  };
}

export function resizeHandleRects(
  screen: ScreenRect,
  size = UI_DESIGN_HANDLE_VISUAL_SIZE_PX,
): Record<HandleEdge, ScreenRect> {
  const half = size / 2;
  const midX = screen.x + screen.width / 2 - half;
  const midY = screen.y + screen.height / 2 - half;
  return {
    nw: { x: screen.x - half, y: screen.y - half, width: size, height: size },
    n: { x: midX, y: screen.y - half, width: size, height: size },
    ne: { x: screen.x + screen.width - half, y: screen.y - half, width: size, height: size },
    e: { x: screen.x + screen.width - half, y: midY, width: size, height: size },
    se: {
      x: screen.x + screen.width - half,
      y: screen.y + screen.height - half,
      width: size,
      height: size,
    },
    s: { x: midX, y: screen.y + screen.height - half, width: size, height: size },
    sw: { x: screen.x - half, y: screen.y + screen.height - half, width: size, height: size },
    w: { x: screen.x - half, y: midY, width: size, height: size },
  };
}

/** 44px hits sit outside the box so a fitted 36px control still has a move interior. */
export function resizeHandleHitRects(
  screen: ScreenRect,
  size = UI_DESIGN_HANDLE_HIT_SIZE_PX,
): Record<HandleEdge, ScreenRect> {
  const midX = screen.x + screen.width / 2 - size / 2;
  const midY = screen.y + screen.height / 2 - size / 2;
  return {
    nw: { x: screen.x - size, y: screen.y - size, width: size, height: size },
    n: { x: midX, y: screen.y - size, width: size, height: size },
    ne: { x: screen.x + screen.width, y: screen.y - size, width: size, height: size },
    e: { x: screen.x + screen.width, y: midY, width: size, height: size },
    se: {
      x: screen.x + screen.width,
      y: screen.y + screen.height,
      width: size,
      height: size,
    },
    s: { x: midX, y: screen.y + screen.height, width: size, height: size },
    sw: { x: screen.x - size, y: screen.y + screen.height, width: size, height: size },
    w: { x: screen.x - size, y: midY, width: size, height: size },
  };
}

export function applyScreenRect(el: HTMLElement | null, rect: ScreenRect): void {
  if (!el) return;
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

/** Zoom and pan so `rect` (design pixels) is centered and readable. */
export function frameRectView(
  viewport: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
  previewScale: number,
  padding = UI_DESIGN_FIT_PADDING_PX,
): DesignView {
  const width = Math.max(1, rect.width * previewScale);
  const height = Math.max(1, rect.height * previewScale);
  const availW = viewport.width - padding * 2;
  const availH = viewport.height - padding * 2;
  const zoom = clampDesignZoom(
    Math.min(
      availW > 0 ? availW / width : 1,
      availH > 0 ? availH / height : 1,
    ),
  );
  const scale = previewScale * zoom;
  return {
    zoom,
    panX: viewport.width / 2 - (rect.x + rect.width / 2) * scale,
    panY: viewport.height / 2 - (rect.y + rect.height / 2) * scale,
  };
}

function rectContains(rect: ScreenRect, point: PointerPoint): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Unmeasured root/canvas must fill the device frame, especially Desired mode.
 */
export function designerControlHitRect(
  control: { id: string; kind: string; guiRect: ScreenRect },
  live: ScreenRect | undefined,
  viewport: { width: number; height: number },
  bitmapScale: number,
  rootId: string,
): ScreenRect {
  if (live && live.width > 0 && live.height > 0) return live;
  if (control.id === rootId) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  return designRectToBitmap(control.guiRect, bitmapScale);
}

/**
 * Prefer moving the widget interior so 44px handle hits do not cover a
 * small control's center. Visual handles stay compact (~14px).
 */
export function designerGestureAt(
  point: PointerPoint,
  screen: ScreenRect,
  options?: { visualSize?: number; hitSize?: number },
): "move" | HandleEdge | null {
  const visual = options?.visualSize ?? UI_DESIGN_HANDLE_VISUAL_SIZE_PX;
  const hit = options?.hitSize ?? UI_DESIGN_HANDLE_HIT_SIZE_PX;
  const inset = Math.max(1, visual / 2);
  const inner = {
    x: screen.x + inset,
    y: screen.y + inset,
    width: screen.width - inset * 2,
    height: screen.height - inset * 2,
  };
  if (inner.width <= 0 || inner.height <= 0) {
    if (rectContains(screen, point)) return "move";
  } else if (rectContains(inner, point)) {
    return "move";
  }
  const handles = resizeHandleHitRects(screen, hit);
  const edges: HandleEdge[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];
  for (const edge of edges) {
    if (rectContains(handles[edge], point)) return edge;
  }
  if (rectContains(screen, point)) return "move";
  return null;
}

export function handleEdges(handle: HandleEdge): {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
} {
  switch (handle) {
    case "e":
      return { right: true };
    case "w":
      return { left: true };
    case "n":
      return { top: true };
    case "s":
      return { bottom: true };
    case "ne":
      return { top: true, right: true };
    case "nw":
      return { top: true, left: true };
    case "se":
      return { bottom: true, right: true };
    case "sw":
      return { bottom: true, left: true };
  }
}
