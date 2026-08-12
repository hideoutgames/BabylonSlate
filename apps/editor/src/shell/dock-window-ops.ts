import type { PanelPlacement } from "@babylonslate/core";
import type { DockWindowDefinition, DockWindowDirection } from "./window-catalog";

export type { PanelPlacement };

export interface DockWindowPanel {
  id: string;
  group?: { id: string; panels?: Array<{ id: string }> };
  api: {
    close: () => void;
    setActive?: () => void;
    width?: number;
    height?: number;
  };
  neighborId?: string;
  neighborDirection?: DockWindowDirection;
}

export interface DockWindowApi {
  getPanel: (id: string) => DockWindowPanel | undefined;
  panels?: Iterable<DockWindowPanel> | DockWindowPanel[];
  addPanel: (options: {
    id: string;
    component: string;
    title?: string;
    position?: {
      referencePanel?: DockWindowPanel | string;
      direction?: DockWindowDirection;
    };
    initialWidth?: number;
    initialHeight?: number;
  }) => DockWindowPanel | void;
  adjacentGroupInDirection?: (
    group: { id: string },
    direction: "left" | "right" | "up" | "down",
  ) => { id: string; panels?: Array<{ id: string }> } | undefined;
}

const ADJACENT_TO_DOCK: Array<
  ["left" | "right" | "up" | "down", DockWindowDirection]
> = [
  ["left", "left"],
  ["right", "right"],
  ["up", "above"],
  ["down", "below"],
];

export function listDockPanels(api: DockWindowApi): DockWindowPanel[] {
  const panels = api.panels;
  if (!panels) return [];
  return Array.isArray(panels) ? panels : [...panels];
}

export function isDockWindowOpen(api: DockWindowApi, id: string): boolean {
  return api.getPanel(id) !== undefined;
}

export function capturePanelPlacement(
  api: DockWindowApi,
  id: string,
): PanelPlacement | null {
  const panel = api.getPanel(id);
  if (!panel) return null;

  const width = panel.api.width;
  const height = panel.api.height;
  const size = {
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  };

  const others = listDockPanels(api).filter((entry) => entry.id !== id);
  const sibling = others.find(
    (entry) =>
      entry.group && panel.group && entry.group.id === panel.group.id,
  );
  if (sibling) {
    return { referencePanelId: sibling.id, direction: "within", ...size };
  }

  if (panel.neighborId && panel.neighborDirection) {
    return {
      referencePanelId: panel.neighborId,
      direction: panel.neighborDirection,
      ...size,
    };
  }

  if (panel.group && api.adjacentGroupInDirection) {
    for (const [nav, direction] of ADJACENT_TO_DOCK) {
      const adjacent = api.adjacentGroupInDirection(panel.group, nav);
      const reference = adjacent?.panels?.[0];
      if (reference) {
        return { referencePanelId: reference.id, direction, ...size };
      }
    }
  }

  if (others[0]) {
    return { referencePanelId: others[0].id, direction: "within", ...size };
  }

  return null;
}

function resolveOpenTarget(
  api: DockWindowApi,
  def: DockWindowDefinition,
  placement?: PanelPlacement | null,
): {
  reference?: DockWindowPanel;
  direction?: DockWindowDirection;
  initialWidth?: number;
  initialHeight?: number;
} {
  if (placement) {
    const remembered = api.getPanel(placement.referencePanelId);
    if (remembered) {
      return {
        reference: remembered,
        direction: placement.direction,
        initialWidth: placement.width,
        initialHeight: placement.height,
      };
    }
  }

  const fallback = def.defaultPosition;
  if (fallback) {
    const reference = api.getPanel(fallback.referencePanelId);
    if (reference) {
      return {
        reference,
        direction: fallback.direction,
        initialWidth: fallback.initialWidth,
        initialHeight: fallback.initialHeight,
      };
    }
  }

  return {};
}

export function openDockWindow(
  api: DockWindowApi,
  def: DockWindowDefinition,
  placement?: PanelPlacement | null,
): void {
  const existing = api.getPanel(def.id);
  if (existing) {
    existing.api.setActive?.();
    return;
  }

  const target = resolveOpenTarget(api, def, placement);
  const panel = api.addPanel({
    id: def.id,
    component: def.component,
    title: def.title,
    ...(target.reference && target.direction
      ? {
          position: {
            referencePanel: target.reference,
            direction: target.direction,
          },
        }
      : {}),
    ...(typeof target.initialWidth === "number"
      ? { initialWidth: target.initialWidth }
      : {}),
    ...(typeof target.initialHeight === "number"
      ? { initialHeight: target.initialHeight }
      : {}),
  });
  panel?.api.setActive?.();
}

export function closeDockWindow(
  api: DockWindowApi,
  id: string,
): PanelPlacement | null {
  if (!isDockWindowOpen(api, id)) return null;
  if (listDockPanels(api).length <= 1) return null;
  const placement = capturePanelPlacement(api, id);
  api.getPanel(id)?.api.close();
  return placement;
}

export function toggleDockWindow(
  api: DockWindowApi,
  def: DockWindowDefinition,
  rememberedPlacement?: PanelPlacement | null,
): { open: boolean; placement: PanelPlacement | null } {
  if (isDockWindowOpen(api, def.id)) {
    if (listDockPanels(api).length <= 1) {
      return { open: true, placement: capturePanelPlacement(api, def.id) };
    }
    const placement = closeDockWindow(api, def.id);
    return { open: false, placement };
  }
  openDockWindow(api, def, rememberedPlacement);
  return { open: true, placement: rememberedPlacement ?? null };
}
