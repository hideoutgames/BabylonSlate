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

type AdjacentNav = "left" | "right" | "up" | "down";

/** Scan direction from this panel → addPanel direction relative to the neighbor. */
const NAV_TO_ADD: Record<AdjacentNav, DockWindowDirection> = {
  left: "right",
  right: "left",
  up: "below",
  down: "above",
};

const PRIMARY_SURFACES = ["viewport", "graph"] as const;

function invertDockDirection(
  direction: DockWindowDirection,
): DockWindowDirection {
  if (direction === "left") return "right";
  if (direction === "right") return "left";
  if (direction === "above") return "below";
  if (direction === "below") return "above";
  return "within";
}

export function listDockPanels(api: DockWindowApi): DockWindowPanel[] {
  const panels = api.panels;
  if (!panels) return [];
  return Array.isArray(panels) ? panels : [...panels];
}

export function isDockWindowOpen(api: DockWindowApi, id: string): boolean {
  return api.getPanel(id) !== undefined;
}

function panelSize(panel: DockWindowPanel): Pick<PanelPlacement, "width" | "height"> {
  const width = panel.api.width;
  const height = panel.api.height;
  return {
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  };
}

function catalogPlacement(
  api: DockWindowApi,
  def: DockWindowDefinition | undefined,
  size: Pick<PanelPlacement, "width" | "height">,
): PanelPlacement | null {
  const fallback = def?.defaultPosition;
  if (!fallback) return null;
  if (!api.getPanel(fallback.referencePanelId)) return null;
  return {
    referencePanelId: fallback.referencePanelId,
    direction: fallback.direction,
    ...size,
  };
}

function collectAdjacentPlacements(
  api: DockWindowApi,
  panel: DockWindowPanel,
  size: Pick<PanelPlacement, "width" | "height">,
): PanelPlacement[] {
  if (!panel.group || !api.adjacentGroupInDirection) return [];
  const found: PanelPlacement[] = [];
  for (const nav of Object.keys(NAV_TO_ADD) as AdjacentNav[]) {
    const adjacent = api.adjacentGroupInDirection(panel.group, nav);
    const reference = adjacent?.panels?.[0];
    if (!reference) continue;
    found.push({
      referencePanelId: reference.id,
      direction: NAV_TO_ADD[nav],
      ...size,
    });
  }
  return found;
}

function pickAdjacentPlacement(
  adjacents: PanelPlacement[],
  def?: DockWindowDefinition,
): PanelPlacement | undefined {
  const preferredIds = [
    def?.defaultPosition?.referencePanelId,
    ...PRIMARY_SURFACES,
  ].filter((id): id is string => Boolean(id));
  for (const id of preferredIds) {
    const match = adjacents.find((entry) => entry.referencePanelId === id);
    if (match) return match;
  }
  return adjacents[0];
}

export function capturePanelPlacement(
  api: DockWindowApi,
  id: string,
  def?: DockWindowDefinition,
): PanelPlacement | null {
  const panel = api.getPanel(id);
  if (!panel) return null;

  const size = panelSize(panel);
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

  const adjacent = pickAdjacentPlacement(
    collectAdjacentPlacements(api, panel, size),
    def,
  );
  if (adjacent) return adjacent;

  return catalogPlacement(api, def, size);
}

function isStaleRememberedPlacement(
  placement: PanelPlacement,
  def: DockWindowDefinition,
): boolean {
  const catalog = def.defaultPosition;
  if (!catalog) return false;
  if (placement.referencePanelId !== catalog.referencePanelId) return false;
  if (placement.direction === "within" && catalog.direction !== "within") {
    return true;
  }
  return (
    catalog.direction !== "within" &&
    placement.direction === invertDockDirection(catalog.direction)
  );
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
  if (placement && !isStaleRememberedPlacement(placement, def)) {
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
  if (panel) {
    panel.api.setActive?.();
  }
}

export function closeDockWindow(
  api: DockWindowApi,
  id: string,
  def?: DockWindowDefinition,
): PanelPlacement | null {
  if (!isDockWindowOpen(api, id)) return null;
  if (listDockPanels(api).length <= 1) return null;
  const placement = capturePanelPlacement(api, id, def);
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
      return { open: true, placement: capturePanelPlacement(api, def.id, def) };
    }
    const placement = closeDockWindow(api, def.id, def);
    return { open: false, placement };
  }
  openDockWindow(api, def, rememberedPlacement);
  return { open: true, placement: rememberedPlacement ?? null };
}
