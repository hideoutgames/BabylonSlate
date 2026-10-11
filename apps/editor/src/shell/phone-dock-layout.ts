import type { DockviewApi } from "dockview-react";
import {
  EVENT_GRAPH_PANEL_ID,
  isFunctionGraphPanelId,
} from "./function-graph-panels";

type DockviewLayout = ReturnType<DockviewApi["toJSON"]>;
type GridNode = DockviewLayout["grid"]["root"];
type DetachedGroup =
  | NonNullable<DockviewLayout["floatingGroups"]>[number]
  | NonNullable<DockviewLayout["popoutGroups"]>[number];
type GroupState = NonNullable<DetachedGroup["data"]>;
const desktopLayouts = new WeakMap<DockviewApi, DockviewLayout>();

/** Size along the docked root for a window moved in from a floating or popout group. */
const INLINED_GROUP_SIZE = 240;

/**
 * A detached window joins the docked root as one node. Its own grid keeps its
 * splits; a child of the root runs across the root, so a window split along
 * the root's direction is wrapped once to keep that direction.
 */
function inlineDetachedGroup(
  group: DetachedGroup,
  rootOrientation: DockviewLayout["grid"]["orientation"],
): GridNode | undefined {
  if (group.grid) {
    const root = { ...group.grid.root, size: INLINED_GROUP_SIZE };
    return group.grid.orientation === rootOrientation
      ? { type: "branch", data: [root], size: INLINED_GROUP_SIZE }
      : root;
  }
  return group.data
    ? { type: "leaf", data: group.data, size: INLINED_GROUP_SIZE }
    : undefined;
}

export function inlineDetachedDockviewLayout(
  layout: DockviewLayout,
): DockviewLayout {
  if (
    layout?.grid?.root?.type !== "branch" ||
    !Array.isArray(layout.grid.root.data)
  ) {
    return layout;
  }
  const detached = [
    ...(layout.floatingGroups ?? []),
    ...(layout.popoutGroups ?? []),
  ];
  if (detached.length === 0) return layout;
  const nodes = detached.flatMap(
    (group) => inlineDetachedGroup(group, layout.grid.orientation) ?? [],
  );
  const result: DockviewLayout = {
    ...layout,
    grid: {
      ...layout.grid,
      root: {
        ...layout.grid.root,
        data: [...layout.grid.root.data, ...nodes],
      },
    },
  };
  delete result.floatingGroups;
  delete result.popoutGroups;
  return result;
}

function layoutGroups(layout: DockviewLayout): GroupState[] {
  const groups: GroupState[] = [];
  const visit = (node: GridNode) => {
    if (node.type === "branch" && Array.isArray(node.data)) {
      node.data.forEach(visit);
    } else {
      groups.push(node.data as GroupState);
    }
  };
  visit(layout.grid.root);
  for (const group of [
    ...(layout.floatingGroups ?? []),
    ...(layout.popoutGroups ?? []),
  ]) {
    if (group.grid) visit(group.grid.root);
    else if (group.data) groups.push(group.data);
  }
  return groups;
}

/**
 * Function graph tabs are document content rather than window choices: one
 * opened or renamed on the phone joins the desktop arrangement, as a tab
 * beside the Event Graph (or another function tab).
 */
function withLiveFunctionGraphs(
  desktop: DockviewLayout,
  api: DockviewApi,
): DockviewLayout {
  const changed = api.panels.filter(
    (panel) =>
      isFunctionGraphPanelId(panel.id) &&
      (!(panel.id in desktop.panels) ||
        desktop.panels[panel.id]!.title !== panel.title),
  );
  if (changed.length === 0) return desktop;
  const layout = structuredClone(desktop);
  const groups = layoutGroups(layout);
  const target =
    groups.find((group) => group.views.includes(EVENT_GRAPH_PANEL_ID)) ??
    groups.find((group) => group.views.some(isFunctionGraphPanelId)) ??
    groups[0];
  for (const panel of changed) {
    const saved = layout.panels[panel.id];
    if (saved) {
      saved.title = panel.title;
    } else if (target) {
      layout.panels[panel.id] = panel.toJSON();
      target.views.push(panel.id);
    }
  }
  return layout;
}

export function isPhoneDockLayout(api: DockviewApi): boolean {
  return desktopLayouts.has(api);
}

/** Phone window selection must never overwrite a document's dock arrangement. */
export function captureAdaptiveDockviewLayout(
  api: DockviewApi,
): Record<string, unknown> {
  const desktop = desktopLayouts.get(api);
  return (
    desktop ? withLiveFunctionGraphs(desktop, api) : api.toJSON()
  ) as unknown as Record<string, unknown>;
}

/** Use Dockview's visibility lifecycle, preserving mounted panel instances. */
export function enterPhoneDockLayout(
  api: DockviewApi,
  desktopLayout?: DockviewLayout,
) {
  const desktop = desktopLayout ?? api.toJSON();
  desktopLayouts.set(api, desktop);
  const activeId = api.activePanel?.id;
  const externalPanels = api.panels.filter(
    (panel) => panel.api.location.type !== "grid",
  );
  if (externalPanels.length > 0) {
    const target =
      api.panels.find((panel) => panel.api.location.type === "grid")?.group ??
      api.addGroup();
    for (const panel of externalPanels) {
      panel.api.moveTo({
        group: target,
        position: "center",
        skipSetActive: true,
      });
    }
    if (activeId) api.getPanel(activeId)?.api.setActive();
  }
  let disposed = false;
  const revealActive = () => {
    if (disposed) return;
    const active = api.activePanel ?? api.panels[0];
    if (active && !active.api.isMaximized()) api.maximizeGroup(active);
  };
  const subscriptions = [
    api.onDidActivePanelChange(revealActive),
    api.onDidAddPanel(revealActive),
    api.onDidRemovePanel(revealActive),
  ];
  revealActive();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  return {
    restore({ allowDetached = true }: { allowDetached?: boolean } = {}) {
      if (disposed) return;
      dispose();
      api.exitMaximizedGroup();
      const layout = withLiveFunctionGraphs(desktop, api);
      api.fromJSON(
        allowDetached ? layout : inlineDetachedDockviewLayout(layout),
        { reuseExistingPanels: true },
      );
      desktopLayouts.delete(api);
    },
    // Keep the snapshot available through the document owner's unmount capture.
    // WeakMap entries disappear along with their disposed Dockview instance.
    dispose,
  };
}
