export type DockviewSurface =
  | "default"
  | "design"
  | "landscape"
  | "foliage"
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

const DOCKVIEW_SURFACES: readonly DockviewSurface[] = [
  "default",
  "stateMachine",
  "animationObject",
  "design",
  "landscape",
  "foliage",
];

export function dockviewApiKeysForDocument(documentId: string): string[] {
  return DOCKVIEW_SURFACES.map((surface) => dockviewApiKey(documentId, surface));
}

/** Each surface key of a renamed document paired with the same surface's new key. */
export function dockviewApiKeyPairs(
  oldId: string,
  newId: string,
): Array<readonly [string, string]> {
  return DOCKVIEW_SURFACES.map(
    (surface) => [dockviewApiKey(oldId, surface), dockviewApiKey(newId, surface)] as const,
  );
}
