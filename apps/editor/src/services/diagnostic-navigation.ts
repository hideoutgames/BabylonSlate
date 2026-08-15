import {
  documentKindForAssetType,
  type DocumentRef,
} from "@babylonslate/core";

/**
 * Play / Compiler Results tap-to-navigate should show the graph that owns the
 * diagnostic. `graphId` is the open document id (`documentId({ kind: "graph", path })`).
 * Session-report rows also open the owning Class / BehaviourTree asset by guid.
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
  entry: {
    btNodeId?: string;
    nodeId?: string;
    assetGuid?: string;
    bodyLine?: number;
  },
  lookup: {
    getByGuid?: (guid: string) =>
      | { header: { type: string; name: string }; path: string }
      | undefined;
  },
): { focusedNodeId: string; document?: DocumentRef; bodyLine?: number } {
  const focusedNodeId = entry.btNodeId ?? entry.nodeId ?? "";
  if (!entry.assetGuid) {
    return { focusedNodeId, bodyLine: entry.bodyLine };
  }
  const asset = lookup.getByGuid?.(entry.assetGuid);
  if (!asset) return { focusedNodeId, bodyLine: entry.bodyLine };
  const kind = documentKindForAssetType(asset.header.type);
  if (!kind) return { focusedNodeId, bodyLine: entry.bodyLine };
  return {
    focusedNodeId,
    bodyLine: entry.bodyLine,
    document: {
      kind,
      path: asset.path,
      label: asset.header.name,
    },
  };
}
