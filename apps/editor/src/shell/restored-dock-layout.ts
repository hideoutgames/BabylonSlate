import type { DockviewApi } from "dockview-react";

type DockviewLayout = ReturnType<DockviewApi["toJSON"]>;
type GridNode = DockviewLayout["grid"]["root"];
type DetachedGroup =
  | NonNullable<DockviewLayout["floatingGroups"]>[number]
  | NonNullable<DockviewLayout["popoutGroups"]>[number];
type GroupState = NonNullable<DetachedGroup["data"]>;

function keptGroup(group: GroupState, known: (id: string) => boolean): GroupState | null {
  const views = group.views.filter(known);
  if (views.length === 0) return null;
  const activeView = group.activeView && views.includes(group.activeView) ? group.activeView : views[0];
  return { ...group, views, activeView };
}

function keptNode(node: GridNode, known: (id: string) => boolean, groups: Set<string>): GridNode | null {
  if (node.type === "branch" && Array.isArray(node.data)) {
    const children = node.data.flatMap((child) => keptNode(child, known, groups) ?? []);
    return children.length > 0 ? { ...node, data: children } : null;
  }
  const group = keptGroup(node.data as GroupState, known);
  if (!group) return null;
  groups.add(group.id);
  return { ...node, data: group };
}

/**
 * A saved layout without the panels `known` rejects (a window the document's
 * catalog no longer lists), and without the groups and splits they leave
 * empty. Null when nothing docked is left, so the default layout is built.
 */
export function withoutUnknownPanels(
  layout: DockviewLayout,
  known: (id: string) => boolean,
): DockviewLayout | null {
  if (!layout?.grid?.root || !layout.panels) return layout;
  if (Object.keys(layout.panels).every(known)) return layout;
  const groups = new Set<string>();
  const root = keptNode(layout.grid.root, known, groups);
  if (!root) return null;
  // A floating or popout window holds one group (`data`) or a grid of them.
  const detached = <T extends DetachedGroup>(entries: T[] | undefined): T[] | undefined => {
    const kept = entries?.flatMap((entry): T[] => {
      if (entry.grid) {
        const gridRoot = keptNode(entry.grid.root, known, groups);
        return gridRoot ? [{ ...entry, grid: { ...entry.grid, root: gridRoot } }] : [];
      }
      const data = entry.data ? keptGroup(entry.data, known) : null;
      if (!data) return [];
      groups.add(data.id);
      return [{ ...entry, data }];
    });
    return kept?.length ? kept : undefined;
  };
  const result: DockviewLayout = {
    ...layout,
    grid: { ...layout.grid, root },
    panels: Object.fromEntries(Object.entries(layout.panels).filter(([id]) => known(id))),
    floatingGroups: detached(layout.floatingGroups),
    popoutGroups: detached(layout.popoutGroups),
  };
  if (!result.floatingGroups) delete result.floatingGroups;
  if (!result.popoutGroups) delete result.popoutGroups;
  if (result.activeGroup && !groups.has(result.activeGroup)) delete result.activeGroup;
  return result;
}
