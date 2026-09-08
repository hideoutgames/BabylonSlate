import type { DockviewApi } from "dockview-react";

type DockviewLayout = ReturnType<DockviewApi["toJSON"]>;
const desktopLayouts = new WeakMap<DockviewApi, DockviewLayout>();

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
  type GridNode = DockviewLayout["grid"]["root"];
  const leaves = (node: GridNode): GridNode[] =>
    node.type === "branch" && Array.isArray(node.data)
      ? node.data.flatMap(leaves)
      : [node];
  const groups: GridNode[] = detached.flatMap((group) =>
    group.grid
      ? leaves(group.grid.root)
      : group.data
        ? [{ type: "leaf" as const, data: group.data, size: 240 }]
        : [],
  );
  const result: DockviewLayout = {
    ...layout,
    grid: {
      ...layout.grid,
      root: {
        ...layout.grid.root,
        data: [...layout.grid.root.data, ...groups],
      },
    },
  };
  delete result.floatingGroups;
  delete result.popoutGroups;
  return result;
}

export function isPhoneDockLayout(api: DockviewApi): boolean {
  return desktopLayouts.has(api);
}

/** Phone window selection must never overwrite a document's dock arrangement. */
export function captureAdaptiveDockviewLayout(
  api: DockviewApi,
): Record<string, unknown> {
  return (desktopLayouts.get(api) ?? api.toJSON()) as unknown as Record<
    string,
    unknown
  >;
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
      api.fromJSON(
        allowDetached ? desktop : inlineDetachedDockviewLayout(desktop),
        { reuseExistingPanels: true },
      );
      desktopLayouts.delete(api);
    },
    // Keep the snapshot available through the document owner's unmount capture.
    // WeakMap entries disappear along with their disposed Dockview instance.
    dispose,
  };
}
