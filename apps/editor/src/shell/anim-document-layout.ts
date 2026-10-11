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

export function normalizeAnimEditorMode(value: unknown): AnimEditorMode {
  return value === "animationObject" ? "animationObject" : "stateMachine";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the stored `{ animEditorMode, stateMachine, animationObject }` layout. */
export function parseAnimDocumentLayout(
  layout: Record<string, unknown> | null | undefined,
): AnimDocumentLayout {
  const stateMachine = layout?.stateMachine;
  const animationObject = layout?.animationObject;
  return {
    animEditorMode: normalizeAnimEditorMode(layout?.animEditorMode),
    stateMachine: isRecord(stateMachine) ? stateMachine : null,
    animationObject: isRecord(animationObject) ? animationObject : null,
  };
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
