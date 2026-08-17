import type { EngineSettings } from "@babylonslate/vfs";
import {
  isDockviewDocumentKind,
  listDockWindows,
  primaryDockPanel,
  type DockviewDocumentKind,
  type DockWindowOptions,
} from "./window-catalog";

export type FocusDocumentKind = DockviewDocumentKind;

export interface FocusKeepCandidate {
  id: string;
  title: string;
}

export type FocusKeepOptions = DockWindowOptions & {
  editorUtilities?: FocusKeepCandidate[];
  openUtilityIds?: string[];
};

function catalogFocusCandidates(
  kind: FocusDocumentKind,
  options?: DockWindowOptions,
): FocusKeepCandidate[] {
  return listDockWindows(kind, options).map((entry) => ({
    id: entry.id,
    title: entry.title,
  }));
}

export function canFocusLayout(kind: string | undefined): boolean {
  return isDockviewDocumentKind(kind);
}

/**
 * Engine Settings keep-list for a document kind.
 * UserInterface Logic uses `uiLogic`; Designer uses `ui`.
 */
export function focusKeepPanelIds(
  settings: Pick<EngineSettings, "focusKeepPanels">,
  kind: FocusDocumentKind,
  options?: DockWindowOptions,
): readonly string[] | undefined {
  const panels = settings.focusKeepPanels;
  if (kind === "ui" && options?.uiEditorMode === "logic") {
    return panels.uiLogic;
  }
  if (kind === "anim-graph" && options?.animEditorMode === "animationObject") {
    return panels.animGraphObject;
  }
  return panels[kind];
}

/** Built-in Scene dock tabs Focus may keep. EditorUtility widgets merge in via `focusKeepCandidates`. */
export const SCENE_FOCUS_CANDIDATES: readonly FocusKeepCandidate[] =
  catalogFocusCandidates("scene");

/** Built-in Class dock tabs Focus may keep. EditorUtility widgets merge in via `focusKeepCandidates`. */
export const GRAPH_FOCUS_CANDIDATES: readonly FocusKeepCandidate[] =
  catalogFocusCandidates("graph");

/** Designer default for `ui`; Logic uses `primaryDockPanel("ui", { uiEditorMode: "logic" })`. */
export const FOCUS_PRIMARY_PANEL: Record<FocusDocumentKind, string> = {
  scene: primaryDockPanel("scene"),
  graph: primaryDockPanel("graph"),
  enum: primaryDockPanel("enum"),
  structure: primaryDockPanel("structure"),
  "script-interface": primaryDockPanel("script-interface"),
  sprite: primaryDockPanel("sprite"),
  tileset: primaryDockPanel("tileset"),
  tilemap: primaryDockPanel("tilemap"),
  material: primaryDockPanel("material"),
  "material-function": primaryDockPanel("material-function"),
  ui: primaryDockPanel("ui"),
  "plugin-settings": primaryDockPanel("plugin-settings"),
  "anim-graph": primaryDockPanel("anim-graph"),
  "behaviour-tree": primaryDockPanel("behaviour-tree"),
  "audio-mixer": primaryDockPanel("audio-mixer"),
  "audio-channel": primaryDockPanel("audio-channel"),
  "sound-attenuation": primaryDockPanel("sound-attenuation"),
};

/**
 * Dock tabs Focus can keep for a document kind.
 * Merge registered EditorUtilityInterface widgets for this kind here when that registry exists.
 */
export function focusKeepCandidates(
  kind: FocusDocumentKind,
  options?: FocusKeepOptions,
): FocusKeepCandidate[] {
  return [
    ...catalogFocusCandidates(kind, options),
    ...(options?.editorUtilities ?? []),
  ];
}

export function resolveFocusKeepPanelIds(
  kind: FocusDocumentKind,
  keepPanelIds: readonly string[] | undefined,
  options?: FocusKeepOptions,
): string[] {
  const openUtilities = (options?.openUtilityIds ?? []).filter(Boolean);
  const keep =
    !keepPanelIds || keepPanelIds.length === 0
      ? [primaryDockPanel(kind, options)]
      : [...keepPanelIds];
  for (const id of openUtilities) {
    if (!keep.includes(id)) keep.push(id);
  }
  return keep;
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
  options?: FocusKeepOptions,
): void {
  const keep = new Set(resolveFocusKeepPanelIds(kind, keepPanelIds, options));
  const openIds = (api.panels ?? []).map((panel) => panel.id);
  for (const id of openIds) {
    if (!keep.has(id)) {
      api.getPanel(id)?.api.close();
    }
  }
}

export interface RestorableDockApi {
  fromJSON: (layout: never) => void;
}

/**
 * Restore a saved DockView snapshot, or build the catalog default.
 * Older catalog JSON can throw from `fromJSON`; fall back rather than
 * unmounting the editor.
 */
export function restoreDockviewLayout(
  api: RestorableDockApi,
  layout: Record<string, unknown> | null | undefined,
  createDefault: () => void,
): void {
  if (layout) {
    try {
      api.fromJSON(layout as never);
      return;
    } catch {
      // Stale layout.json from an older panel catalog.
    }
  }
  createDefault();
}

/** Drop retired panels and restack Class under Components. */
export function migrateRestoredLayout(api: FocusableDockApi): void {
  api.getPanel("mini-asset-browser")?.api.close();
  api.getPanel("ui-logic")?.api.close();
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
