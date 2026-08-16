import type { DockviewSurface } from "./dockview-surface";

export type AnimEditorMode = "stateMachine" | "animationObject";

export type AnimDocumentLayout = {
  animEditorMode: AnimEditorMode;
  stateMachine: Record<string, unknown> | null;
  animationObject: Record<string, unknown> | null;
};

export type AnimPreFocusSnapshot = {
  layout: Record<string, unknown>;
  surface: DockviewSurface;
};

const SPLIT_KEYS = new Set(["animEditorMode", "stateMachine", "animationObject"]);

export function normalizeAnimEditorMode(value: unknown): AnimEditorMode {
  return value === "animationObject" ? "animationObject" : "stateMachine";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSplitAnimLayout(layout: Record<string, unknown>): boolean {
  return Object.keys(layout).some((key) => SPLIT_KEYS.has(key));
}

/** Split a stored Animation Graph layout, migrating a raw DockView snapshot to State Machine. */
export function parseAnimDocumentLayout(
  layout: Record<string, unknown> | null | undefined,
): AnimDocumentLayout {
  if (!layout) {
    return { animEditorMode: "stateMachine", stateMachine: null, animationObject: null };
  }
  if (isSplitAnimLayout(layout)) {
    return {
      animEditorMode: normalizeAnimEditorMode(layout.animEditorMode),
      stateMachine: isRecord(layout.stateMachine) ? layout.stateMachine : null,
      animationObject: isRecord(layout.animationObject)
        ? layout.animationObject
        : null,
    };
  }
  return { animEditorMode: "stateMachine", stateMachine: layout, animationObject: null };
}

export function serializeAnimDocumentLayout(
  layout: AnimDocumentLayout,
): Record<string, unknown> {
  return {
    animEditorMode: layout.animEditorMode,
    stateMachine: layout.stateMachine,
    animationObject: layout.animationObject,
  };
}

export function applyPreFocusToAnimLayout(
  current: AnimDocumentLayout,
  snapshot: AnimPreFocusSnapshot,
): AnimDocumentLayout {
  if (snapshot.surface === "stateMachine") {
    return { ...current, stateMachine: snapshot.layout };
  }
  if (snapshot.surface === "animationObject") {
    return { ...current, animationObject: snapshot.layout };
  }
  return current;
}
