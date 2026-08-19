import type { HorizontalAlignment, VerticalAlignment, WidgetLayout } from "./types";
import { ZERO_INSETS } from "./types";
import { clamp01, previewRect } from "./preview-rect";

type LegacyLayout = {
  anchorMin?: { x?: unknown; y?: unknown };
  anchorMax?: { x?: unknown; y?: unknown };
  offsetMin?: { x?: unknown; y?: unknown };
  offsetMax?: { x?: unknown; y?: unknown };
  pivot?: { x?: unknown; y?: unknown };
};

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isLegacyRectTransform(value: unknown): value is LegacyLayout {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "anchorMin" in record && !("horizontalAlignment" in record);
}

export function isBabylonWidgetLayout(value: unknown): value is WidgetLayout {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.horizontalAlignment === "string";
}

function nearestAlignX(anchor: number): HorizontalAlignment {
  if (anchor < 0.25) return "left";
  if (anchor > 0.75) return "right";
  return "center";
}

function nearestAlignY(anchor: number): VerticalAlignment {
  // Legacy layout is Y-up (1 = top). Babylon is Y-down (top = 0).
  if (anchor > 0.75) return "top";
  if (anchor < 0.25) return "bottom";
  return "center";
}

/**
 * Convert a Unity/UMG RectTransform into Babylon alignment / px / padding.
 * Uses a unit parent so pin vs stretch is recovered from anchors.
 */
export function migrateLegacyLayout(raw: LegacyLayout): WidgetLayout {
  const minX = clamp01(num(raw.anchorMin?.x));
  const minY = clamp01(num(raw.anchorMin?.y));
  const maxX = Math.max(minX, clamp01(num(raw.anchorMax?.x, 1)));
  const maxY = Math.max(minY, clamp01(num(raw.anchorMax?.y, 1)));
  const parent = { x: 0, y: 0, width: 1000, height: 1000 };
  const left = parent.width * minX + num(raw.offsetMin?.x);
  const bottom = parent.height * minY + num(raw.offsetMin?.y);
  const right = parent.width * maxX + num(raw.offsetMax?.x);
  const top = parent.height * maxY + num(raw.offsetMax?.y);
  const width = Math.max(0, right - left);
  const height = Math.max(0, top - bottom);
  const guiY = parent.height - top;
  const stretchX = Math.abs(maxX - minX) > 1e-4;
  const stretchY = Math.abs(maxY - minY) > 1e-4;
  const padding = { ...ZERO_INSETS };
  if (stretchX) {
    padding.left = left;
    padding.right = parent.width - right;
  }
  if (stretchY) {
    padding.top = guiY;
    padding.bottom = bottom;
  }
  const layout: WidgetLayout = {
    horizontalAlignment: stretchX ? "left" : nearestAlignX((minX + maxX) / 2),
    verticalAlignment: stretchY ? "top" : nearestAlignY((minY + maxY) / 2),
    width: stretchX ? 100 : width,
    height: stretchY ? 100 : height,
    widthUnit: stretchX ? "percent" : "px",
    heightUnit: stretchY ? "percent" : "px",
    left: 0,
    top: 0,
    leftUnit: "px",
    topUnit: "px",
    padding,
    transformCenter: {
      x: clamp01(num(raw.pivot?.x, 0.5)),
      y: clamp01(num(raw.pivot?.y, 0.5)),
    },
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };
  if (!stretchX || !stretchY) {
    const target = { x: left, y: guiY, width, height };
    const preview = previewRect(parent, layout);
    layout.left += target.x - preview.x;
    layout.top += target.y - preview.y;
  }
  return layout;
}

export function migrateUserInterfacePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const widgets = payload.widgets;
  if (!widgets || typeof widgets !== "object") return payload;
  const next: Record<string, unknown> = {};
  for (const [id, widget] of Object.entries(widgets as Record<string, unknown>)) {
    if (!widget || typeof widget !== "object") {
      next[id] = widget;
      continue;
    }
    const record = widget as Record<string, unknown>;
    next[id] = {
      ...record,
      layout: isLegacyRectTransform(record.layout)
        ? migrateLegacyLayout(record.layout)
        : record.layout,
    };
  }
  return { ...payload, widgets: next };
}
