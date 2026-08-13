/**
 * Play / Compiler Results tap-to-navigate should show the graph that owns the
 * diagnostic. `graphId` is the open document id (`documentId({ kind: "graph", path })`).
 */
export function documentIdToRevealForDiagnostic(
  diagnostic: { graphId: string },
  openDocumentIds: readonly string[],
): string | null {
  return openDocumentIds.includes(diagnostic.graphId)
    ? diagnostic.graphId
    : null;
}
