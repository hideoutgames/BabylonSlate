/** Dockview panel ids closed when entering Focus on a scene (if maximize is unavailable). */
export const SCENE_FOCUS_HIDE = [
  "scene-outliner",
  "scene-details",
  "output-log",
  "mini-asset-browser",
] as const;

/** Dockview panel ids closed when entering Focus on a graph. */
export const GRAPH_FOCUS_HIDE = ["prefab-viewport", "compiler-results"] as const;

export interface FocusablePanelApi {
  maximize?: () => void;
  close: () => void;
  moveTo?: (options: { position?: string; group?: unknown }) => void;
}

export interface FocusableDockApi {
  getPanel: (
    id: string,
  ) => { api: FocusablePanelApi; group?: unknown } | undefined;
}

/** Collapse the dock to the document's primary editing surface. */
export function applyFocusLayout(
  kind: "scene" | "graph",
  api: FocusableDockApi,
): void {
  if (kind === "scene") {
    const viewport = api.getPanel("viewport");
    if (typeof viewport?.api.maximize === "function") {
      viewport.api.maximize();
      return;
    }
    for (const id of SCENE_FOCUS_HIDE) {
      api.getPanel(id)?.api.close();
    }
    return;
  }
  for (const id of GRAPH_FOCUS_HIDE) {
    api.getPanel(id)?.api.close();
  }
}

/** Drop retired panels and restack My Blueprint under Components. */
export function migrateRestoredLayout(api: FocusableDockApi): void {
  api.getPanel("mini-asset-browser")?.api.close();
  const myClass = api.getPanel("my-class");
  const components = api.getPanel("actor-prefab");
  if (
    myClass &&
    components &&
    myClass.group &&
    myClass.group === components.group &&
    typeof myClass.api.moveTo === "function"
  ) {
    myClass.api.moveTo({ position: "bottom", group: components.group });
  }
}
