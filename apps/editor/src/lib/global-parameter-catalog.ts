import { useMemo } from "react";
import {
  GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE,
  normalizeGlobalParameterCollection,
  type GlobalParameterCatalog,
} from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const GLOBAL_PARAMETER_DOCUMENT_KINDS = ["global-parameter-collection"] as const;

/**
 * Every Global Parameter Collection's parameters by guid: an open tab's unsaved document first,
 * else the header snapshot saved with the asset, so nothing needs loading.
 */
function collectGlobalParameterCatalog(
  assets: readonly { path: string; header: { guid: string; type: string; payload?: unknown } }[],
  documents: readonly { ref: { path: string }; content?: unknown }[] = [],
): GlobalParameterCatalog {
  const open = new Map(documents.map((doc) => [doc.ref.path, doc.content]));
  const catalog: GlobalParameterCatalog = {};
  for (const asset of assets) {
    if (asset.header.type !== GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE) continue;
    catalog[asset.header.guid] = normalizeGlobalParameterCollection(open.get(asset.path) ?? asset.header.payload).parameters;
  }
  return catalog;
}

/** The project's Global Parameter Collections, following open tabs as they are edited. */
export function useGlobalParameterCatalog(): GlobalParameterCatalog {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const openDocuments = useOpenDocumentsOfKinds(GLOBAL_PARAMETER_DOCUMENT_KINDS);
  return useMemo(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    return collectGlobalParameterCatalog(assetRegistry?.list() ?? [], openDocuments);
  }, [assetRegistry, registryEpoch, openDocuments]);
}
