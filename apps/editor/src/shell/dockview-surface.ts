export type DockviewSurface =
  | "default"
  | "stateMachine"
  | "animationObject";

export type PreFocusSnapshot = {
  layout: Record<string, unknown>;
  surface: DockviewSurface;
};

export function dockviewSurfaceForAnimMode(
  mode: "stateMachine" | "animationObject",
): DockviewSurface {
  return mode;
}

export function dockviewApiKey(
  documentId: string,
  surface: DockviewSurface = "default",
): string {
  return surface === "default" ? documentId : `${documentId}::${surface}`;
}

export function dockviewApiKeysForDocument(documentId: string): string[] {
  return [
    dockviewApiKey(documentId),
    dockviewApiKey(documentId, "stateMachine"),
    dockviewApiKey(documentId, "animationObject"),
  ];
}
