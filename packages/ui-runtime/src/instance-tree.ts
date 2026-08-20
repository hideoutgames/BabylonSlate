import {
  canonicalWidgetKind,
  createDefaultUserInterface,
  createWidget,
  type UserInterfaceDocument,
  type WidgetKind,
  type WidgetLayout,
  type WidgetNode,
} from "./types";
import { defaultAddLayout } from "./layout-authoring";
import { insertWidget, removeWidget, reparentWidget, widgetParentId } from "./widget-tree";

export type WidgetLayoutPatch = Partial<
  Pick<
    WidgetLayout,
    | "left"
    | "top"
    | "leftUnit"
    | "topUnit"
    | "width"
    | "height"
    | "widthUnit"
    | "heightUnit"
    | "rotation"
    | "scaleX"
    | "scaleY"
    | "horizontalAlignment"
    | "verticalAlignment"
  >
>;

export type UiTreeAddWidget = {
  widgetId: string;
  kind: string;
  name: string;
  parentId: string;
};

export type UiTreeReparentWidget = {
  widgetId: string;
  parentId: string;
  siblingIndex?: number;
};

function cloneLayout(layout: WidgetLayout): WidgetLayout {
  return {
    ...layout,
    padding: { ...layout.padding },
    transformCenter: { ...layout.transformCenter },
  };
}

function cloneWidget(widget: WidgetNode): WidgetNode {
  return {
    ...widget,
    children: [...widget.children],
    layout: cloneLayout(widget.layout),
    style: { ...widget.style },
    props: { ...widget.props },
    ...(widget.overrides ? { overrides: { ...widget.overrides } } : {}),
  };
}

export function cloneUserInterfaceDocument(
  doc: UserInterfaceDocument,
): UserInterfaceDocument {
  const widgets: Record<string, WidgetNode> = {};
  for (const [id, widget] of Object.entries(doc.widgets)) {
    widgets[id] = cloneWidget(widget);
  }
  return {
    ...doc,
    designResolution: { ...doc.designResolution },
    desiredSize: { ...doc.desiredSize },
    widgets,
  };
}

export function userInterfaceDocumentFromMeta(
  name: string,
  widgets: readonly { id: string; kind: string; name?: string }[],
): UserInterfaceDocument {
  const rows = widgets.filter((row) => typeof row.id === "string" && row.id.trim());
  const canvas =
    rows.find((row) => canonicalWidgetKind(row.kind) === "Canvas") ?? rows[0];
  const rootId = canvas?.id?.trim() || "canvas";
  const rootName =
    (canvas && typeof canvas.name === "string" && canvas.name.trim()
      ? canvas.name
      : "Canvas") ?? "Canvas";
  const root = createWidget(rootId, "Canvas", rootName);
  const children: string[] = [];
  const map: Record<string, WidgetNode> = { [rootId]: root };
  for (const row of rows) {
    if (row.id === rootId) continue;
    const kind = canonicalWidgetKind(row.kind);
    const widgetName =
      typeof row.name === "string" && row.name.trim() ? row.name : kind;
    map[row.id] = createWidget(
      row.id,
      kind,
      widgetName,
      defaultAddLayout(kind, children.length, "Canvas"),
    );
    children.push(row.id);
  }
  map[rootId] = { ...root, children };
  const doc = createDefaultUserInterface(name);
  return {
    ...doc,
    name,
    rootId,
    widgets: map,
  };
}

export function applyUiTreeAddWidget(
  doc: UserInterfaceDocument,
  command: UiTreeAddWidget,
): UserInterfaceDocument {
  const widgetId = command.widgetId.trim();
  const parentId = command.parentId.trim() || doc.rootId;
  if (!widgetId || doc.widgets[widgetId] || !doc.widgets[parentId]) return doc;
  const kind = canonicalWidgetKind(command.kind);
  if (kind === "Canvas") return doc;
  const name =
    typeof command.name === "string" && command.name.trim()
      ? command.name.trim()
      : kind;
  const parentKind = doc.widgets[parentId]?.kind as WidgetKind | undefined;
  const widget = createWidget(
    widgetId,
    kind,
    name,
    defaultAddLayout(kind, doc.widgets[parentId]?.children.length ?? 0, parentKind),
  );
  return insertWidget(doc, widget, parentId);
}

export function applyUiTreeRemoveWidget(
  doc: UserInterfaceDocument,
  widgetId: string,
): UserInterfaceDocument {
  return removeWidget(doc, widgetId);
}

export function applyUiTreeReparentWidget(
  doc: UserInterfaceDocument,
  command: UiTreeReparentWidget,
): UserInterfaceDocument {
  const widgetId = command.widgetId.trim();
  const parentId = command.parentId.trim();
  if (!widgetId || !parentId || widgetId === doc.rootId) return doc;
  if (!doc.widgets[widgetId] || !doc.widgets[parentId]) return doc;
  const sameParent = widgetParentId(doc, widgetId) === parentId;
  let next = sameParent
    ? cloneUserInterfaceDocument(doc)
    : reparentWidget(doc, widgetId, parentId, "into");
  if (!sameParent && next === doc) return doc;
  if (command.siblingIndex === undefined) return next;
  const parent = next.widgets[parentId];
  if (!parent) return next;
  const children = parent.children.filter((id) => id !== widgetId);
  const index = Math.max(
    0,
    Math.min(Math.floor(command.siblingIndex), children.length),
  );
  children.splice(index, 0, widgetId);
  return {
    ...next,
    widgets: {
      ...next.widgets,
      [parentId]: { ...parent, children },
    },
  };
}

export function applyUiTreePatchLayout(
  doc: UserInterfaceDocument,
  widgetId: string,
  patch: WidgetLayoutPatch,
): UserInterfaceDocument {
  const widget = doc.widgets[widgetId];
  if (!widget) return doc;
  const next = cloneUserInterfaceDocument(doc);
  const current = next.widgets[widgetId];
  if (!current) return doc;
  next.widgets[widgetId] = {
    ...current,
    layout: { ...current.layout, ...patch },
  };
  return next;
}
