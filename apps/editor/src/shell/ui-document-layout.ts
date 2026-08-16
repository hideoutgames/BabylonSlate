import type { DockviewSurface } from "./dockview-surface";

export type UiEditorMode = "designer" | "logic";

export type UiDocumentLayout = {
  uiEditorMode: UiEditorMode;
  designer: Record<string, unknown> | null;
  logic: Record<string, unknown> | null;
};

export type PreFocusSnapshot = {
  layout: Record<string, unknown>;
  surface: DockviewSurface;
};

const SPLIT_KEYS = new Set(["uiEditorMode", "designer", "logic"]);

export function normalizeUiEditorMode(value: unknown): UiEditorMode {
  return value === "logic" ? "logic" : "designer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSplitUiLayout(layout: Record<string, unknown>): boolean {
  return Object.keys(layout).some((key) => SPLIT_KEYS.has(key));
}

/** Split a stored UI document layout, migrating a raw DockView snapshot to Designer. */
export function parseUiDocumentLayout(
  layout: Record<string, unknown> | null | undefined,
): UiDocumentLayout {
  if (!layout) {
    return { uiEditorMode: "designer", designer: null, logic: null };
  }
  if (isSplitUiLayout(layout)) {
    return {
      uiEditorMode: normalizeUiEditorMode(layout.uiEditorMode),
      designer: isRecord(layout.designer) ? layout.designer : null,
      logic: isRecord(layout.logic) ? layout.logic : null,
    };
  }
  return { uiEditorMode: "designer", designer: layout, logic: null };
}

export function serializeUiDocumentLayout(
  layout: UiDocumentLayout,
): Record<string, unknown> {
  return {
    uiEditorMode: layout.uiEditorMode,
    designer: layout.designer,
    logic: layout.logic,
  };
}

/** Persist a pre-Focus DockView snapshot into the matching Designer or Logic slot. */
export function applyPreFocusToUiLayout(
  current: UiDocumentLayout,
  snapshot: PreFocusSnapshot,
): UiDocumentLayout {
  if (snapshot.surface === "designer") {
    return { ...current, designer: snapshot.layout };
  }
  if (snapshot.surface === "logic") {
    return { ...current, logic: snapshot.layout };
  }
  return current;
}
