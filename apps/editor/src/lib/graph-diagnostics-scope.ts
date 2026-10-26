export function shouldPublishGraphDiagnostics(options: {
  documentId: string;
  activeDocumentId: string | null | undefined;
  documentKind: string;
  animEditorMode?: "stateMachine" | "animationObject";
  /** A Scene or Scene Layer publishes graph diagnostics only in Script mode. */
  sceneMode?: string;
}): boolean {
  if (options.documentId !== options.activeDocumentId) return false;
  if (
    (options.documentKind === "scene" || options.documentKind === "scene-layer") &&
    options.sceneMode !== "script"
  ) {
    return false;
  }
  if (
    options.documentKind === "anim-graph" &&
    options.animEditorMode !== "animationObject"
  ) {
    return false;
  }
  return true;
}
