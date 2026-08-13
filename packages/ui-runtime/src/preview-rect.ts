import type { Rect, WidgetLayout } from "./types";

export function clamp01(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return 1;
  return Math.max(0, Math.min(1, value));
}

export function roundRect(rect: Rect, digits = 3): Rect {
  const f = 10 ** digits;
  return {
    x: Math.round(rect.x * f) / f,
    y: Math.round(rect.y * f) / f,
    width: Math.round(rect.width * f) / f,
    height: Math.round(rect.height * f) / f,
  };
}

function dimension(value: number, unit: WidgetLayout["widthUnit"], parentSize: number): number {
  if (unit === "percent") return parentSize * (value / 100);
  return value;
}

/**
 * Mirrors Babylon GUI `_measure` + `_computeAlignment` (px/%, alignment, padding, left/top).
 * Parent origin is top-left (Y-down), matching ADT — not Unity Y-up.
 */
export function previewRect(parent: Rect, layout: WidgetLayout): Rect {
  const width = Math.max(0, dimension(layout.width, layout.widthUnit, parent.width));
  const height = Math.max(0, dimension(layout.height, layout.heightUnit, parent.height));
  const padding = layout.padding;
  let x = 0;
  let y = 0;
  switch (layout.horizontalAlignment) {
    case "right":
      x = parent.width - width;
      break;
    case "center":
      x = (parent.width - width) / 2;
      break;
    default:
      x = 0;
  }
  switch (layout.verticalAlignment) {
    case "bottom":
      y = parent.height - height;
      break;
    case "center":
      y = (parent.height - height) / 2;
      break;
    default:
      y = 0;
  }
  const left = parent.x + padding.left + layout.left + x;
  const top = parent.y + padding.top + layout.top + y;
  return {
    x: left,
    y: top,
    width: Math.max(0, width - padding.left - padding.right),
    height: Math.max(0, height - padding.top - padding.bottom),
  };
}
