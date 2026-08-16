export function shouldPublishGraphDiagnostics(options: {
  documentId: string;
  activeDocumentId: string | null | undefined;
  documentKind: string;
  uiEditorMode?: "designer" | "logic";
}): boolean {
  if (options.documentId !== options.activeDocumentId) return false;
  if (options.documentKind === "ui" && options.uiEditorMode !== "logic") {
    return false;
  }
  return true;
}
