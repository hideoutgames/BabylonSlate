import type { UserInterfaceDocument, WidgetNode } from "./types";

function cloneDoc(doc: UserInterfaceDocument): UserInterfaceDocument {
  return {
    ...doc,
    widgets: { ...doc.widgets },
    desiredSize: { ...doc.desiredSize },
    designResolution: { ...doc.designResolution },
  };
}

function collectDescendants(
  doc: UserInterfaceDocument,
  id: string,
  into: Set<string> = new Set(),
): Set<string> {
  const widget = doc.widgets[id];
  if (!widget) return into;
  for (const child of widget.children) {
    into.add(child);
    collectDescendants(doc, child, into);
  }
  return into;
}

export function widgetParentId(
  doc: UserInterfaceDocument,
  id: string,
): string | null {
  for (const widget of Object.values(doc.widgets)) {
    if (widget.children.includes(id)) return widget.id;
  }
  return null;
}

export function insertWidget(
  doc: UserInterfaceDocument,
  widget: WidgetNode,
  parentId: string,
): UserInterfaceDocument {
  const parent = doc.widgets[parentId];
  if (!parent) return doc;
  const next = cloneDoc(doc);
  next.widgets[widget.id] = {
    ...widget,
    children: [...widget.children],
    layout: { ...widget.layout },
    style: { ...widget.style },
    props: { ...widget.props },
  };
  next.widgets[parentId] = {
    ...parent,
    children: [...parent.children, widget.id],
  };
  return next;
}

export function removeWidget(
  doc: UserInterfaceDocument,
  id: string,
): UserInterfaceDocument {
  if (id === doc.rootId || !doc.widgets[id]) return doc;
  const doomed = collectDescendants(doc, id);
  doomed.add(id);
  const parentId = widgetParentId(doc, id);
  const next = cloneDoc(doc);
  for (const dead of doomed) {
    delete next.widgets[dead];
  }
  if (parentId && next.widgets[parentId]) {
    const parent = next.widgets[parentId]!;
    next.widgets[parentId] = {
      ...parent,
      children: parent.children.filter((child) => child !== id),
    };
  }
  return next;
}

export function reparentWidget(
  doc: UserInterfaceDocument,
  id: string,
  newParentId: string,
): UserInterfaceDocument {
  if (id === doc.rootId || id === newParentId) return doc;
  const widget = doc.widgets[id];
  const newParent = doc.widgets[newParentId];
  if (!widget || !newParent) return doc;
  const descendants = collectDescendants(doc, id);
  if (descendants.has(newParentId)) return doc;
  const oldParentId = widgetParentId(doc, id);
  if (!oldParentId || oldParentId === newParentId) return doc;
  const oldParent = doc.widgets[oldParentId];
  if (!oldParent) return doc;
  const next = cloneDoc(doc);
  next.widgets[oldParentId] = {
    ...oldParent,
    children: oldParent.children.filter((child) => child !== id),
  };
  const dest = next.widgets[newParentId]!;
  next.widgets[newParentId] = {
    ...dest,
    children: [...dest.children, id],
  };
  return next;
}

export function duplicateWidget(
  doc: UserInterfaceDocument,
  id: string,
  newId: string,
): UserInterfaceDocument {
  const source = doc.widgets[id];
  const parentId = widgetParentId(doc, id);
  if (!source || !parentId || newId === id || doc.widgets[newId]) return doc;
  const copy: WidgetNode = {
    ...source,
    id: newId,
    name: `${source.name} Copy`,
    children: [],
    layout: {
      ...source.layout,
      anchorMin: { ...source.layout.anchorMin },
      anchorMax: { ...source.layout.anchorMax },
      offsetMin: { ...source.layout.offsetMin },
      offsetMax: { ...source.layout.offsetMax },
      pivot: { ...source.layout.pivot },
    },
    style: { ...source.style, padding: source.style.padding ? { ...source.style.padding } : undefined },
    props: { ...source.props },
  };
  return insertWidget(doc, copy, parentId);
}
