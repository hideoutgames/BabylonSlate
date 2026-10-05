import { useMemo } from "react";
import type { DocumentKind } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import {
  documentKindsRevision,
  type OpenDocument,
} from "../services/document-service";

/** Material and Material Instance tabs, whose unsaved domains win over headers. */
export const MATERIAL_DOCUMENT_KINDS = ["material", "material-instance"] as const;

/**
 * The open documents of `kinds`, in tab order, including their unsaved
 * content. The list keeps its identity until a document of one of those kinds
 * opens, closes, moves, is reordered or edited, or changes layout or dirty
 * state. Memos that read other documents key on it (plus `registryEpoch` when
 * they also read the registry), so edits to other kinds, tab switches and
 * registry-only updates do not recompute them. Pass a module-level constant.
 */
export function useOpenDocumentsOfKinds(
  kinds: readonly DocumentKind[],
): OpenDocument[] {
  const { documentRevisions, getOpenDocuments } = useDocuments();
  const revision = documentKindsRevision(documentRevisions, kinds);
  return useMemo(() => {
    void revision;
    return getOpenDocuments().filter((doc) => kinds.includes(doc.ref.kind));
  }, [getOpenDocuments, kinds, revision]);
}
