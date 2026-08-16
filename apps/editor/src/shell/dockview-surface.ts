import type { UiEditorMode } from "./ui-document-layout";

export type DockviewSurface = "default" | "designer" | "logic";

export function dockviewSurfaceForUiMode(mode: UiEditorMode): DockviewSurface {
  return mode === "logic" ? "logic" : "designer";
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
    dockviewApiKey(documentId, "designer"),
    dockviewApiKey(documentId, "logic"),
  ];
}
