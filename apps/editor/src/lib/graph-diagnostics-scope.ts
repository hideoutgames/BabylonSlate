export function shouldPublishGraphDiagnostics(options: {
  documentId: string;
  activeDocumentId: string | null | undefined;
  documentKind: string;
  uiEditorMode?: "designer" | "logic";
  animEditorMode?: "stateMachine" | "animationObject";
}): boolean {
  if (options.documentId !== options.activeDocumentId) return false;
  if (options.documentKind === "ui" && options.uiEditorMode !== "logic") {
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
