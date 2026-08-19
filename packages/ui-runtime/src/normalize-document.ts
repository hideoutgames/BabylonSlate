import {
  WIDGET_KINDS,
  canonicalWidgetKind,
  defaultHitTestableFor,
  createWidget,
  defaultPropsFor,
  defaultWidgetStyle,
  stretchLayout,
  type UserInterfaceDocument,
  type WidgetKind,
  type WidgetNode,
} from "./types";
import { normalizeLayout } from "./layout";
import {
  isBabylonWidgetLayout,
  isLegacyRectTransform,
  migrateLegacyLayout,
  migrateUserInterfacePayload,
} from "./migrate-layout";
import { migrateUserInterfaceV3 } from "./migrate-v3";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sizeFrom(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { width?: unknown; height?: unknown };
  const width = record.width;
  const height = record.height;
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function isWidgetKind(value: unknown): value is WidgetKind {
  return typeof value === "string" && (WIDGET_KINDS as readonly string[]).includes(value);
}

function widgetKindFrom(value: unknown): WidgetKind {
  if (isWidgetKind(value)) return value;
  return canonicalWidgetKind(value);
}

function normalizeWidget(id: string, value: unknown): WidgetNode {
  const record = asRecord(value);
  const kind = widgetKindFrom(record.kind);
  const base = createWidget(id, kind, typeof record.name === "string" ? record.name : kind);
  const layout = isLegacyRectTransform(record.layout)
    ? migrateLegacyLayout(record.layout)
    : isBabylonWidgetLayout(record.layout)
      ? normalizeLayout(record.layout)
      : kind === "Canvas"
        ? stretchLayout()
        : base.layout;
  const children = Array.isArray(record.children)
    ? record.children.filter((child): child is string => typeof child === "string")
    : [];
  const style = {
    ...defaultWidgetStyle(),
    ...(record.style && typeof record.style === "object" ? record.style : {}),
  };
  const props = {
    ...defaultPropsFor(kind),
    ...(record.props && typeof record.props === "object" ? record.props : {}),
  };
  return {
    ...base,
    name: typeof record.name === "string" && record.name ? record.name : base.name,
    layout,
    visible: record.visible !== false,
    children,
    style,
    props,
    nestedUiGuid: typeof record.nestedUiGuid === "string" ? record.nestedUiGuid : null,
    visualOverrideGuid:
      typeof record.visualOverrideGuid === "string" ? record.visualOverrideGuid : null,
    ignoreSafeArea: record.ignoreSafeArea === true,
    hitTestable:
      typeof record.hitTestable === "boolean"
        ? record.hitTestable
        : defaultHitTestableFor(kind),
    gridColumn: typeof record.gridColumn === "number" ? record.gridColumn : undefined,
    gridRow: typeof record.gridRow === "number" ? record.gridRow : undefined,
    zIndex: typeof record.zIndex === "number" ? record.zIndex : undefined,
    exposed:
      record.exposed && typeof record.exposed === "object"
        ? (record.exposed as WidgetNode["exposed"])
        : null,
    overrides:
      record.overrides && typeof record.overrides === "object"
        ? (record.overrides as WidgetNode["overrides"])
        : undefined,
  };
}

/**
 * Hydrate a UserInterface payload into a document
 * that always has a root widget, layout, style, props, and children arrays.
 */
export function normalizeUserInterfaceDocument(value: unknown): UserInterfaceDocument {
  const record = migrateUserInterfaceV3(migrateUserInterfacePayload(asRecord(value)));
  const designResolution =
    sizeFrom(record.designResolution) ?? { width: 1920, height: 1080 };
  const rawWidgets = asRecord(record.widgets);
  const widgets: UserInterfaceDocument["widgets"] = {};
  for (const [id, widget] of Object.entries(rawWidgets)) {
    widgets[id] = normalizeWidget(id, widget);
  }
  const rootId = typeof record.rootId === "string" && record.rootId ? record.rootId : "canvas";
  if (!widgets[rootId]) {
    widgets[rootId] = createWidget(rootId, "Canvas", "Canvas");
  }
  for (const widget of Object.values(widgets)) {
    widget.children = widget.children.filter((child) => Boolean(widgets[child]));
  }
  return {
    name: typeof record.name === "string" && record.name ? record.name : "HUD",
    rootId,
    designResolution,
    desiredSize: sizeFrom(record.desiredSize) ?? { ...designResolution },
    scaleRule:
      record.scaleRule === "fitWidth" || record.scaleRule === "fitHeight"
        ? record.scaleRule
        : "shortestSide",
    viewportLayer: record.viewportLayer !== false,
    widgets,
  };
}
