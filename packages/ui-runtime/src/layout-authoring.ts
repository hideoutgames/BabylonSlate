import { normalizeLayout } from "./layout";
import { previewRect } from "./preview-rect";
import type {
  HorizontalAlignment,
  LayoutResult,
  Rect,
  UserInterfaceDocument,
  VerticalAlignment,
  WidgetKind,
  WidgetLayout,
} from "./types";
import { pinLayout, stretchLayout, ZERO_INSETS } from "./types";
import { widgetParentId } from "./widget-tree";

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
  horizontalAlignment: HorizontalAlignment;
  verticalAlignment: VerticalAlignment;
  stretchX: boolean;
  stretchY: boolean;
}

export const ANCHOR_PRESETS: readonly AnchorPreset[] = [
  { id: "top-left", label: "Top Left", horizontalAlignment: "left", verticalAlignment: "top", stretchX: false, stretchY: false },
  { id: "top-center", label: "Top Center", horizontalAlignment: "center", verticalAlignment: "top", stretchX: false, stretchY: false },
  { id: "top-right", label: "Top Right", horizontalAlignment: "right", verticalAlignment: "top", stretchX: false, stretchY: false },
  { id: "middle-left", label: "Middle Left", horizontalAlignment: "left", verticalAlignment: "center", stretchX: false, stretchY: false },
  { id: "middle-center", label: "Middle Center", horizontalAlignment: "center", verticalAlignment: "center", stretchX: false, stretchY: false },
  { id: "middle-right", label: "Middle Right", horizontalAlignment: "right", verticalAlignment: "center", stretchX: false, stretchY: false },
  { id: "bottom-left", label: "Bottom Left", horizontalAlignment: "left", verticalAlignment: "bottom", stretchX: false, stretchY: false },
  { id: "bottom-center", label: "Bottom Center", horizontalAlignment: "center", verticalAlignment: "bottom", stretchX: false, stretchY: false },
  { id: "bottom-right", label: "Bottom Right", horizontalAlignment: "right", verticalAlignment: "bottom", stretchX: false, stretchY: false },
  { id: "top-stretch", label: "Top Stretch", horizontalAlignment: "left", verticalAlignment: "top", stretchX: true, stretchY: false },
  { id: "middle-stretch", label: "Middle Stretch", horizontalAlignment: "left", verticalAlignment: "center", stretchX: true, stretchY: false },
  { id: "bottom-stretch", label: "Bottom Stretch", horizontalAlignment: "left", verticalAlignment: "bottom", stretchX: true, stretchY: false },
  { id: "left-stretch", label: "Left Stretch", horizontalAlignment: "left", verticalAlignment: "top", stretchX: false, stretchY: true },
  { id: "center-stretch", label: "Center Stretch", horizontalAlignment: "center", verticalAlignment: "top", stretchX: false, stretchY: true },
  { id: "right-stretch", label: "Right Stretch", horizontalAlignment: "right", verticalAlignment: "top", stretchX: false, stretchY: true },
  { id: "stretch-stretch", label: "Stretch", horizontalAlignment: "left", verticalAlignment: "top", stretchX: true, stretchY: true },
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

export function widgetAllowsDesignerTransform(
  doc: UserInterfaceDocument,
  widgetId: string,
): boolean {
  if (widgetId === doc.rootId || !doc.widgets[widgetId]) return false;
  const parentId = widgetParentId(doc, widgetId);
  if (!parentId) return false;
  const parent = doc.widgets[parentId];
  if (!parent) return false;
  return !parentOwnsChildLayout(parent.kind);
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
  return pinLayout("center", "center", size.width, size.height);
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= ANCHOR_EPS;
}

export function layoutFromRect(
  parent: Rect,
  rect: Rect,
  presetId: AnchorPresetId = "top-left",
  transformCenter = { x: 0.5, y: 0.5 },
): WidgetLayout {
  const preset = PRESET_BY_ID.get(presetId) ?? ANCHOR_PRESETS[0]!;
  const padding = { ...ZERO_INSETS };
  if (preset.stretchX) {
    padding.left = Math.max(0, rect.x - parent.x);
    padding.right = Math.max(0, parent.x + parent.width - (rect.x + rect.width));
  }
  if (preset.stretchY) {
    padding.top = Math.max(0, rect.y - parent.y);
    padding.bottom = Math.max(0, parent.y + parent.height - (rect.y + rect.height));
  }
  const width = preset.stretchX ? 100 : rect.width;
  const height = preset.stretchY ? 100 : rect.height;
  const layout: WidgetLayout = {
    horizontalAlignment: preset.horizontalAlignment,
    verticalAlignment: preset.verticalAlignment,
    width,
    height,
    widthUnit: preset.stretchX ? "percent" : "px",
    heightUnit: preset.stretchY ? "percent" : "px",
    left: 0,
    top: 0,
    padding,
    transformCenter: { ...transformCenter },
  };
  if (!preset.stretchX || !preset.stretchY) {
    const preview = previewRect(parent, layout);
    if (!preset.stretchX) layout.left = rect.x - preview.x;
    if (!preset.stretchY) layout.top = rect.y - preview.y;
  }
  return normalizeLayout(layout);
}

export function applyAnchorPreset(
  layout: WidgetLayout,
  parent: Rect,
  presetId: AnchorPresetId,
): WidgetLayout {
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset) return layout;
  const rect = previewRect(parent, normalizeLayout(layout));
  return layoutFromRect(parent, rect, presetId, layout.transformCenter);
}

export function matchAnchorPreset(layout: WidgetLayout): AnchorPresetId | null {
  const slot = normalizeLayout(layout);
  const stretchX = slot.widthUnit === "percent" && nearlyEqual(slot.width, 100);
  const stretchY = slot.heightUnit === "percent" && nearlyEqual(slot.height, 100);
  for (const preset of ANCHOR_PRESETS) {
    if (
      preset.horizontalAlignment === slot.horizontalAlignment &&
      preset.verticalAlignment === slot.verticalAlignment &&
      preset.stretchX === stretchX &&
      preset.stretchY === stretchY
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
  widthUnit: WidgetLayout["widthUnit"];
  heightUnit: WidgetLayout["heightUnit"];
  horizontalAlignment: HorizontalAlignment;
  verticalAlignment: VerticalAlignment;
}

export function authoringFieldsFromLayout(
  parent: Rect,
  layout: WidgetLayout,
): AuthoringFields {
  void parent;
  const slot = normalizeLayout(layout);
  const pinX = slot.widthUnit === "px";
  const pinY = slot.heightUnit === "px";
  return {
    pinX,
    pinY,
    posX: slot.left,
    posY: slot.top,
    width: slot.width,
    height: slot.height,
    left: slot.padding.left,
    right: slot.padding.right,
    top: slot.padding.top,
    bottom: slot.padding.bottom,
    widthUnit: slot.widthUnit,
    heightUnit: slot.heightUnit,
    horizontalAlignment: slot.horizontalAlignment,
    verticalAlignment: slot.verticalAlignment,
  };
}

export type AuthoringFieldPatch = Partial<
  Pick<
    AuthoringFields,
    | "posX"
    | "posY"
    | "width"
    | "height"
    | "left"
    | "right"
    | "top"
    | "bottom"
    | "widthUnit"
    | "heightUnit"
    | "horizontalAlignment"
    | "verticalAlignment"
  >
>;

export function applyAuthoringFields(
  layout: WidgetLayout,
  parent: Rect,
  patch: AuthoringFieldPatch,
): WidgetLayout {
  const slot = normalizeLayout(layout);
  const next: WidgetLayout = {
    ...slot,
    left: patch.posX ?? slot.left,
    top: patch.posY ?? slot.top,
    width: patch.width ?? slot.width,
    height: patch.height ?? slot.height,
    widthUnit: patch.widthUnit ?? slot.widthUnit,
    heightUnit: patch.heightUnit ?? slot.heightUnit,
    horizontalAlignment: patch.horizontalAlignment ?? slot.horizontalAlignment,
    verticalAlignment: patch.verticalAlignment ?? slot.verticalAlignment,
    padding: {
      left: patch.left ?? slot.padding.left,
      right: patch.right ?? slot.padding.right,
      top: patch.top ?? slot.padding.top,
      bottom: patch.bottom ?? slot.padding.bottom,
    },
  };
  void parent;
  return normalizeLayout(next);
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export function laidOutParentRect(
  result: LayoutResult,
  widgetId: string,
): Rect {
  if (!result.tree || result.tree.id === widgetId) return result.canvas;
  const stack = [result.tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.some((child) => child.id === widgetId)) return node.rect;
    for (const child of node.children) stack.push(child);
  }
  return result.canvas;
}

export function applyWidgetResize(
  layout: WidgetLayout,
  parent: Rect,
  delta: { x: number; y: number },
  edges: ResizeEdges,
): WidgetLayout {
  const slot = normalizeLayout(layout);
  const rect = previewRect(parent, slot);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (edges.left) left += delta.x;
  if (edges.right) right += delta.x;
  if (edges.top) top += delta.y;
  if (edges.bottom) bottom += delta.y;
  if (right < left) {
    const mid = left;
    left = right;
    right = mid;
  }
  if (bottom < top) {
    const mid = top;
    top = bottom;
    bottom = mid;
  }
  const preset = matchAnchorPreset(slot) ?? "top-left";
  return layoutFromRect(
    parent,
    { x: left, y: top, width: right - left, height: bottom - top },
    preset,
    slot.transformCenter,
  );
}

export { stretchLayout, pinLayout };
