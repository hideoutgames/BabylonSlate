import {
  createDefaultUserInterface,
  createWidget,
  type UserInterfaceDocument,
  type WidgetNode,
} from "./types";
import { widgetParentId } from "./widget-tree";

function cloneWidgets(
  source: UserInterfaceDocument,
  rootId: string,
): Record<string, WidgetNode> {
  const widgets: Record<string, WidgetNode> = {};
  const visit = (id: string) => {
    const widget = source.widgets[id];
    if (!widget || widgets[id]) return;
    widgets[id] = {
      ...widget,
      children: [...widget.children],
      layout: { ...widget.layout, padding: { ...widget.layout.padding } },
      style: { ...widget.style },
      props: { ...widget.props },
    };
    for (const child of widget.children) visit(child);
  };
  visit(rootId);
  return widgets;
}

export type ExtractWidgetAsPrefabResult = {
  prefab: UserInterfaceDocument;
  nextHost: UserInterfaceDocument;
  slotId: string;
};

/**
 * Extract a widget subtree into a prefab (`viewportLayer: false`) and replace
 * it in the host with a UserInterface instance slot.
 */
export function extractWidgetAsPrefab(
  host: UserInterfaceDocument,
  widgetId: string,
  prefabName: string,
): ExtractWidgetAsPrefabResult {
  const widget = host.widgets[widgetId];
  if (!widget || widgetId === host.rootId) {
    throw new Error("Cannot extract the Canvas root");
  }
  const parentId = widgetParentId(host, widgetId);
  if (!parentId) throw new Error("Widget has no parent");

  const prefab = createDefaultUserInterface(prefabName);
  prefab.viewportLayer = false;
  const extracted = cloneWidgets(host, widgetId);
  prefab.widgets = {
    ...prefab.widgets,
    ...extracted,
    canvas: {
      ...prefab.widgets.canvas!,
      children: [widgetId],
    },
  };
  prefab.desiredSize = {
    width: Math.max(1, widget.layout.width),
    height: Math.max(1, widget.layout.height),
  };

  const slotId = `ui-${widgetId}`;
  const slot: WidgetNode = {
    ...createWidget(slotId, "UserInterface", widget.name, widget.layout),
    nestedUiGuid: null,
  };

  const nextWidgets = { ...host.widgets };
  for (const id of Object.keys(extracted)) {
    delete nextWidgets[id];
  }
  const parent = nextWidgets[parentId];
  if (!parent) throw new Error("Parent missing after extract");
  nextWidgets[parentId] = {
    ...parent,
    children: parent.children.map((id) => (id === widgetId ? slotId : id)),
  };
  nextWidgets[slotId] = slot;

  return {
    prefab,
    nextHost: { ...host, widgets: nextWidgets },
    slotId,
  };
}
