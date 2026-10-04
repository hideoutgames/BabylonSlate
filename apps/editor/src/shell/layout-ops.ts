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

export type FocusKeepOptions = DockWindowOptions;

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
 * Animation Object uses `animGraphObject`; State Machine uses `anim-graph`.
 */
export function focusKeepPanelIds(
  settings: Pick<EngineSettings, "focusKeepPanels">,
  kind: FocusDocumentKind,
  options?: DockWindowOptions,
): readonly string[] | undefined {
  const panels = settings.focusKeepPanels;
  if (kind === "scene" && options?.sceneMode === "landscape") return panels.sceneLandscape;
  if (kind === "scene" && options?.sceneMode === "foliage") return panels.sceneFoliage;
  if (kind === "anim-graph" && options?.animEditorMode === "animationObject") {
    return panels.animGraphObject;
  }
  const configured: Partial<Record<FocusDocumentKind, readonly string[]>> = panels;
  return configured[kind];
}

/**
 * Dock tabs Focus can keep for a document kind.
 */
export function focusKeepCandidates(
  kind: FocusDocumentKind,
  options?: FocusKeepOptions,
): FocusKeepCandidate[] {
  return catalogFocusCandidates(kind, options);
}

export function resolveFocusKeepPanelIds(
  kind: FocusDocumentKind,
  keepPanelIds: readonly string[] | undefined,
  options?: FocusKeepOptions,
): string[] {
  const keep =
    !keepPanelIds || keepPanelIds.length === 0
      ? [primaryDockPanel(kind, options)]
      : [...keepPanelIds];
  return keep;
}

export interface FocusablePanelApi<Group = unknown> {
  maximize?: () => void;
  close: () => void;
  moveTo?: (options: { position?: "bottom"; group?: Group }) => void;
}

export interface FocusableDockApi<Group = unknown> {
  getPanel: (
    id: string,
  ) => { api: FocusablePanelApi<Group>; group?: Group } | undefined;
  panels?: ReadonlyArray<{ id: string }>;
}

/** Collapse the dock to keep-listed panels that are already open. */
export function applyFocusLayout<Group>(
  kind: FocusDocumentKind,
  api: FocusableDockApi<Group>,
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
export function migrateRestoredLayout<Group>(api: FocusableDockApi<Group>): void {
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
