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

export interface FocusableDockApi {
  getPanel: (id: string) => { api: { close: () => void } } | undefined;
  panels?: ReadonlyArray<{ id: string }>;
  activePanel?: { id: string };
}

/**
 * Collapse the dock to keep-listed panels that are already open. When none of
 * them is open, the primary panel, or else the active one, stays so Focus
 * never empties the dock.
 */
export function applyFocusLayout(
  kind: FocusDocumentKind,
  api: FocusableDockApi,
  keepPanelIds?: readonly string[],
  options?: FocusKeepOptions,
): void {
  const keep = new Set(resolveFocusKeepPanelIds(kind, keepPanelIds, options));
  const openIds = (api.panels ?? []).map((panel) => panel.id);
  if (!openIds.some((id) => keep.has(id))) {
    const primary = primaryDockPanel(kind, options);
    const fallback = openIds.includes(primary)
      ? primary
      : (api.activePanel?.id ?? openIds[0]);
    if (fallback) keep.add(fallback);
  }
  for (const id of openIds) {
    if (!keep.has(id)) {
      api.getPanel(id)?.api.close();
    }
  }
}
