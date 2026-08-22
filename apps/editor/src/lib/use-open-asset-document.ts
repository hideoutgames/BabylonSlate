import { useCallback } from "react";
import {
  documentId,
  documentKindForAssetType,
  labelFromPath,
} from "@babylonslate/core";
import { useDocuments } from "../context/document-context";

export interface AssetTabTarget {
  /** Asset header type string (e.g. `asset.header.type`) — NOT a nested header. */
  type: string;
  path: string;
}

export interface OpenAssetDocumentOptions {
  /** Receives a human-readable message when opening the document fails. */
  onError?: (message: string) => void;
}

/**
 * Open an asset reference in an editor document tab, mirroring the Content
 * Browser: focuses the existing tab when one is already open, otherwise opens
 * the document (scene exclusivity / dirty guards apply inside `openDocument`).
 * No-op for entries whose type maps to no document kind or that lack a path.
 */
export function useOpenAssetDocument(
  options: OpenAssetDocumentOptions = {},
): (entry: AssetTabTarget) => Promise<void> {
  const { tabOrder, openDocument, setActiveDocument } = useDocuments();
  const onError = options.onError;
  return useCallback(
    async (entry: AssetTabTarget) => {
      const kind = documentKindForAssetType(entry.type);
      if (!kind || !entry.path) return;
      const id = documentId({ kind, path: entry.path });
      if (tabOrder.includes(id)) {
        setActiveDocument(id);
        return;
      }
      try {
        await openDocument({
          kind,
          path: entry.path,
          label: labelFromPath(entry.path),
        });
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    },
    [onError, openDocument, setActiveDocument, tabOrder],
  );
}
