import { listDockWindows, type DockviewDocumentKind, type DockWindowOptions } from "./window-catalog";

export type FocusDocumentKind = DockviewDocumentKind;

export interface FocusKeepCandidate {
  id: string;
  title: string;
}

function catalogFocusCandidates(
  kind: FocusDocumentKind,
  options?: DockWindowOptions,
): FocusKeepCandidate[] {
  return listDockWindows(kind, options).map((entry) => ({
    id: entry.id,
    title: entry.title,
  }));
}

/** Built-in Scene dock tabs Focus may keep. EditorUtility widgets merge in via `focusKeepCandidates`. */
export const SCENE_FOCUS_CANDIDATES: readonly FocusKeepCandidate[] =
  catalogFocusCandidates("scene");

/** Built-in Class dock tabs Focus may keep. EditorUtility widgets merge in via `focusKeepCandidates`. */
export const GRAPH_FOCUS_CANDIDATES: readonly FocusKeepCandidate[] =
  catalogFocusCandidates("graph");

export const FOCUS_PRIMARY_PANEL: Record<FocusDocumentKind, string> = {
  scene: "viewport",
  graph: "graph",
  enum: "enum-members",
  structure: "structure-members",
  "script-interface": "script-interface-preview",
};

/**
 * Dock tabs Focus can keep for a document kind.
 * Merge registered EditorUtilityInterface widgets for this kind here when that registry exists.
 */
export function focusKeepCandidates(
  kind: FocusDocumentKind,
  options?: DockWindowOptions,
): FocusKeepCandidate[] {
  return catalogFocusCandidates(kind, options);
}

export function resolveFocusKeepPanelIds(
  kind: FocusDocumentKind,
  keepPanelIds: readonly string[] | undefined,
): string[] {
  if (!keepPanelIds || keepPanelIds.length === 0) {
    return [FOCUS_PRIMARY_PANEL[kind]];
  }
  return [...keepPanelIds];
}

export interface FocusablePanelApi {
  maximize?: () => void;
  close: () => void;
  moveTo?: (options: { position?: string; group?: unknown }) => void;
}

export interface FocusableDockApi {
  getPanel: (
    id: string,
  ) => { api: FocusablePanelApi; group?: unknown } | undefined;
  panels?: ReadonlyArray<{ id: string }>;
}

/** Collapse the dock to keep-listed panels that are already open. */
export function applyFocusLayout(
  kind: FocusDocumentKind,
  api: FocusableDockApi,
  keepPanelIds?: readonly string[],
): void {
  const keep = new Set(resolveFocusKeepPanelIds(kind, keepPanelIds));
  const openIds = (api.panels ?? []).map((panel) => panel.id);
  for (const id of openIds) {
    if (!keep.has(id)) {
      api.getPanel(id)?.api.close();
    }
  }
}

/** Drop retired panels and restack Class under Components. */
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
