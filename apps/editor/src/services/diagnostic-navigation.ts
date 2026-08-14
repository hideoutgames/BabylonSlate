import {
  documentKindForAssetType,
  type DocumentRef,
} from "@babylonslate/core";

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

export function sessionReportNavigation(
  entry: { btNodeId?: string; nodeId?: string; assetGuid?: string },
  lookup: {
    getByGuid?: (guid: string) =>
      | { header: { type: string; name: string }; path: string }
      | undefined;
  },
): { focusedNodeId: string; document?: DocumentRef } {
  const focusedNodeId = entry.btNodeId ?? entry.nodeId ?? "";
  if (!entry.btNodeId || !entry.assetGuid) {
    return { focusedNodeId };
  }
  const asset = lookup.getByGuid?.(entry.assetGuid);
  if (!asset) return { focusedNodeId };
  const kind = documentKindForAssetType(asset.header.type);
  if (!kind) return { focusedNodeId };
  return {
    focusedNodeId,
    document: {
      kind,
      path: asset.path,
      label: asset.header.name,
    },
  };
}
