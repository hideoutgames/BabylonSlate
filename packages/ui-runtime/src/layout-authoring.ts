import { computeAnchoredRect, normalizeLayout } from "./layout";
import type { Rect, Vec2, WidgetKind, WidgetLayout } from "./types";

const ANCHOR_EPS = 1e-4;

export type AnchorPresetId =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "top-stretch"
  | "middle-stretch"
  | "bottom-stretch"
  | "left-stretch"
  | "center-stretch"
  | "right-stretch"
  | "stretch-stretch";

export interface AnchorPreset {
  id: AnchorPresetId;
  label: string;
  anchorMin: Vec2;
  anchorMax: Vec2;
}

export const ANCHOR_PRESETS: readonly AnchorPreset[] = [
  { id: "top-left", label: "Top Left", anchorMin: { x: 0, y: 1 }, anchorMax: { x: 0, y: 1 } },
  { id: "top-center", label: "Top Center", anchorMin: { x: 0.5, y: 1 }, anchorMax: { x: 0.5, y: 1 } },
  { id: "top-right", label: "Top Right", anchorMin: { x: 1, y: 1 }, anchorMax: { x: 1, y: 1 } },
  { id: "middle-left", label: "Middle Left", anchorMin: { x: 0, y: 0.5 }, anchorMax: { x: 0, y: 0.5 } },
  { id: "middle-center", label: "Middle Center", anchorMin: { x: 0.5, y: 0.5 }, anchorMax: { x: 0.5, y: 0.5 } },
  { id: "middle-right", label: "Middle Right", anchorMin: { x: 1, y: 0.5 }, anchorMax: { x: 1, y: 0.5 } },
  { id: "bottom-left", label: "Bottom Left", anchorMin: { x: 0, y: 0 }, anchorMax: { x: 0, y: 0 } },
  { id: "bottom-center", label: "Bottom Center", anchorMin: { x: 0.5, y: 0 }, anchorMax: { x: 0.5, y: 0 } },
  { id: "bottom-right", label: "Bottom Right", anchorMin: { x: 1, y: 0 }, anchorMax: { x: 1, y: 0 } },
  { id: "top-stretch", label: "Top Stretch", anchorMin: { x: 0, y: 1 }, anchorMax: { x: 1, y: 1 } },
  { id: "middle-stretch", label: "Middle Stretch", anchorMin: { x: 0, y: 0.5 }, anchorMax: { x: 1, y: 0.5 } },
  { id: "bottom-stretch", label: "Bottom Stretch", anchorMin: { x: 0, y: 0 }, anchorMax: { x: 1, y: 0 } },
  { id: "left-stretch", label: "Left Stretch", anchorMin: { x: 0, y: 0 }, anchorMax: { x: 0, y: 1 } },
  { id: "center-stretch", label: "Center Stretch", anchorMin: { x: 0.5, y: 0 }, anchorMax: { x: 0.5, y: 1 } },
  { id: "right-stretch", label: "Right Stretch", anchorMin: { x: 1, y: 0 }, anchorMax: { x: 1, y: 1 } },
  { id: "stretch-stretch", label: "Stretch", anchorMin: { x: 0, y: 0 }, anchorMax: { x: 1, y: 1 } },
];

const PRESET_BY_ID = new Map(ANCHOR_PRESETS.map((row) => [row.id, row]));

const SLOT_LAYOUT_PARENTS: ReadonlySet<WidgetKind> = new Set([
  "HorizontalBox",
  "VerticalBox",
  "Grid",
  "SizeBox",
]);

export function parentOwnsChildLayout(kind: WidgetKind): boolean {
  return SLOT_LAYOUT_PARENTS.has(kind);
}

export function preferredWidgetSize(kind: WidgetKind): { width: number; height: number } {
  switch (kind) {
    case "Text":
    case "Button":
      return { width: 160, height: 36 };
    case "TextInput":
      return { width: 200, height: 36 };
    case "Slider":
      return { width: 200, height: 24 };
    case "CheckBox":
      return { width: 28, height: 28 };
    case "Image":
      return { width: 128, height: 128 };
    case "ProgressBar":
      return { width: 200, height: 16 };
    case "Spacer":
      return { width: 24, height: 24 };
    case "SizeBox":
      return { width: 100, height: 100 };
    case "TouchJoystick":
    case "TouchDPad":
      return { width: 160, height: 160 };
    case "TouchButton":
      return { width: 72, height: 72 };
    case "UserInterface":
      return { width: 400, height: 300 };
    default:
      return { width: 200, height: 120 };
  }
}

export function defaultAddLayout(kind: WidgetKind): WidgetLayout {
  const size = preferredWidgetSize(kind);
  const pivot = { x: 0.5, y: 0.5 };
  return {
    anchorMin: { x: 0.5, y: 0.5 },
    anchorMax: { x: 0.5, y: 0.5 },
    offsetMin: { x: -size.width * pivot.x, y: -size.height * pivot.y },
    offsetMax: { x: size.width * (1 - pivot.x), y: size.height * (1 - pivot.y) },
    pivot,
  };
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= ANCHOR_EPS;
}

export function layoutFromRect(
  parent: Rect,
  rect: Rect,
  anchorMin: Vec2,
  anchorMax: Vec2,
  pivot: Vec2 = { x: 0.5, y: 0.5 },
): WidgetLayout {
  const min = { x: anchorMin.x, y: anchorMin.y };
  const max = { x: anchorMax.x, y: anchorMax.y };
  const left = rect.x;
  const bottom = rect.y;
  const right = rect.x + rect.width;
  const top = rect.y + rect.height;
  return normalizeLayout({
    anchorMin: min,
    anchorMax: max,
    offsetMin: {
      x: left - parent.x - parent.width * min.x,
      y: bottom - parent.y - parent.height * min.y,
    },
    offsetMax: {
      x: right - parent.x - parent.width * max.x,
      y: top - parent.y - parent.height * max.y,
    },
    pivot,
  });
}

export function applyAnchorPreset(
  layout: WidgetLayout,
  parent: Rect,
  presetId: AnchorPresetId,
): WidgetLayout {
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset) return layout;
  const rect = computeAnchoredRect(parent, layout);
  return layoutFromRect(parent, rect, preset.anchorMin, preset.anchorMax, layout.pivot);
}

export function matchAnchorPreset(layout: WidgetLayout): AnchorPresetId | null {
  const normalized = normalizeLayout(layout);
  for (const preset of ANCHOR_PRESETS) {
    if (
      nearlyEqual(normalized.anchorMin.x, preset.anchorMin.x) &&
      nearlyEqual(normalized.anchorMin.y, preset.anchorMin.y) &&
      nearlyEqual(normalized.anchorMax.x, preset.anchorMax.x) &&
      nearlyEqual(normalized.anchorMax.y, preset.anchorMax.y)
    ) {
      return preset.id;
    }
  }
  return null;
}

export interface AuthoringFields {
  pinX: boolean;
  pinY: boolean;
  posX: number;
  posY: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function authoringFieldsFromLayout(
  parent: Rect,
  layout: WidgetLayout,
): AuthoringFields {
  const slot = normalizeLayout(layout);
  const rect = computeAnchoredRect(parent, slot);
  const pinX = nearlyEqual(slot.anchorMin.x, slot.anchorMax.x);
  const pinY = nearlyEqual(slot.anchorMin.y, slot.anchorMax.y);
  const left = rect.x - (parent.x + parent.width * slot.anchorMin.x);
  const right = parent.x + parent.width * slot.anchorMax.x - (rect.x + rect.width);
  const bottom = rect.y - (parent.y + parent.height * slot.anchorMin.y);
  const top = parent.y + parent.height * slot.anchorMax.y - (rect.y + rect.height);
  const posX =
    rect.x + rect.width * slot.pivot.x - (parent.x + parent.width * slot.anchorMin.x);
  const posY =
    rect.y + rect.height * slot.pivot.y - (parent.y + parent.height * slot.anchorMin.y);
  return {
    pinX,
    pinY,
    posX,
    posY,
    width: rect.width,
    height: rect.height,
    left,
    right,
    top,
    bottom,
  };
}

export type AuthoringFieldPatch = Partial<
  Pick<AuthoringFields, "posX" | "posY" | "width" | "height" | "left" | "right" | "top" | "bottom">
>;

export function applyAuthoringFields(
  layout: WidgetLayout,
  parent: Rect,
  patch: AuthoringFieldPatch,
): WidgetLayout {
  const slot = normalizeLayout(layout);
  const fields = authoringFieldsFromLayout(parent, slot);
  const next = { ...fields, ...patch };
  const pinX = fields.pinX;
  const pinY = fields.pinY;
  let left: number;
  let right: number;
  let bottom: number;
  let top: number;
  if (pinX) {
    const width = Math.max(0, next.width);
    const pivotX = slot.pivot.x;
    const anchorX = parent.x + parent.width * slot.anchorMin.x;
    const pivotWorldX = anchorX + next.posX;
    left = pivotWorldX - width * pivotX;
    right = left + width;
  } else {
    left = parent.x + parent.width * slot.anchorMin.x + next.left;
    right = parent.x + parent.width * slot.anchorMax.x - next.right;
  }
  if (pinY) {
    const height = Math.max(0, next.height);
    const pivotY = slot.pivot.y;
    const anchorY = parent.y + parent.height * slot.anchorMin.y;
    const pivotWorldY = anchorY + next.posY;
    bottom = pivotWorldY - height * pivotY;
    top = bottom + height;
  } else {
    bottom = parent.y + parent.height * slot.anchorMin.y + next.bottom;
    top = parent.y + parent.height * slot.anchorMax.y - next.top;
  }
  return layoutFromRect(
    parent,
    {
      x: left,
      y: bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, top - bottom),
    },
    slot.anchorMin,
    slot.anchorMax,
    slot.pivot,
  );
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export function applyWidgetResize(
  layout: WidgetLayout,
  parent: Rect,
  delta: Vec2,
  edges: ResizeEdges,
): WidgetLayout {
  const rect = computeAnchoredRect(parent, layout);
  let left = rect.x;
  let bottom = rect.y;
  let right = rect.x + rect.width;
  let top = rect.y + rect.height;
  if (edges.left) left += delta.x;
  if (edges.right) right += delta.x;
  if (edges.bottom) bottom += delta.y;
  if (edges.top) top += delta.y;
  if (right < left) {
    const mid = left;
    left = right;
    right = mid;
  }
  if (top < bottom) {
    const mid = bottom;
    bottom = top;
    top = mid;
  }
  return layoutFromRect(
    parent,
    { x: left, y: bottom, width: right - left, height: top - bottom },
    layout.anchorMin,
    layout.anchorMax,
    layout.pivot,
  );
}
