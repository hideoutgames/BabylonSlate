import type { WidgetLayout } from "@babylonslate/ui-runtime";

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

/** Screen Y-down to layout Y-up (ui-runtime parent bottom-left). */
export function canvasDeltaToLayoutDelta(
  screenDelta: PointerPoint,
  viewScale: number,
): PointerPoint {
  const scale =
    !Number.isFinite(viewScale) || viewScale === 0 ? 1 : viewScale;
  return {
    x: screenDelta.x / scale,
    y: -screenDelta.y / scale,
  };
}

/** Translate a widget in parent space without changing anchors or size. */
export function applyWidgetDragOffset(
  layout: WidgetLayout,
  delta: PointerPoint,
): WidgetLayout {
  return {
    ...layout,
    offsetMin: {
      x: layout.offsetMin.x + delta.x,
      y: layout.offsetMin.y + delta.y,
    },
    offsetMax: {
      x: layout.offsetMax.x + delta.x,
      y: layout.offsetMax.y + delta.y,
    },
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
