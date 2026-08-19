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
  targetId: string,
  placement: "before" | "into" | "after" = "into",
): UserInterfaceDocument {
  if (id === doc.rootId || id === targetId) return doc;
  const widget = doc.widgets[id];
  const target = doc.widgets[targetId];
  if (!widget || !target) return doc;
  const descendants = collectDescendants(doc, id);
  if (descendants.has(targetId)) return doc;

  const oldParentId = widgetParentId(doc, id);
  if (!oldParentId) return doc;

  const around = placement === "before" || placement === "after";
  const newParentId = around ? widgetParentId(doc, targetId) : targetId;
  if (!newParentId || newParentId === id || descendants.has(newParentId)) {
    return doc;
  }
  if (!around && oldParentId === newParentId) return doc;

  const oldParent = doc.widgets[oldParentId];
  const newParent = doc.widgets[newParentId];
  if (!oldParent || !newParent) return doc;

  const next = cloneDoc(doc);
  const fromParent = next.widgets[oldParentId]!;
  next.widgets[oldParentId] = {
    ...fromParent,
    children: fromParent.children.filter((child) => child !== id),
  };
  const dest = next.widgets[newParentId]!;
  const children = dest.children.filter((child) => child !== id);
  if (around) {
    const anchorIndex = children.indexOf(targetId);
    const insertAt =
      anchorIndex < 0
        ? children.length
        : placement === "before"
          ? anchorIndex
          : anchorIndex + 1;
    children.splice(insertAt, 0, id);
  } else {
    children.push(id);
  }
  next.widgets[newParentId] = { ...dest, children };
  return next;
}

function cloneLayout(layout: WidgetNode["layout"]): WidgetNode["layout"] {
  return {
    ...layout,
    padding: { ...layout.padding },
    transformCenter: { ...layout.transformCenter },
  };
}

function cloneSubtree(
  doc: UserInterfaceDocument,
  sourceId: string,
  newId: string,
  rename: boolean,
): WidgetNode[] {
  const source = doc.widgets[sourceId];
  if (!source) return [];
  const childCopies: WidgetNode[] = [];
  const childIds: string[] = [];
  for (const childId of source.children) {
    const childNewId = `${newId}:${childId}`;
    childIds.push(childNewId);
    childCopies.push(...cloneSubtree(doc, childId, childNewId, false));
  }
  const copy: WidgetNode = {
    ...source,
    id: newId,
    name: rename ? `${source.name} Copy` : source.name,
    children: childIds,
    layout: cloneLayout(source.layout),
    style: {
      ...source.style,
      padding: source.style.padding ? { ...source.style.padding } : undefined,
    },
    props: { ...source.props },
  };
  return [copy, ...childCopies];
}

export function duplicateWidget(
  doc: UserInterfaceDocument,
  id: string,
  newId: string,
): UserInterfaceDocument {
  const source = doc.widgets[id];
  const parentId = widgetParentId(doc, id);
  if (!source || !parentId || newId === id || doc.widgets[newId]) return doc;
  const copies = cloneSubtree(doc, id, newId, true);
  const rootCopy = copies[0];
  if (!rootCopy) return doc;
  let next = insertWidget(doc, rootCopy, parentId);
  for (const extra of copies.slice(1)) {
    if (next.widgets[extra.id]) continue;
    next = {
      ...next,
      widgets: { ...next.widgets, [extra.id]: extra },
    };
  }
  return next;
}
