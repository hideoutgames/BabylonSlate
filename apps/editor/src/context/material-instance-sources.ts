import { useEffect, useMemo, useRef, useState } from "react";
import {
  MATERIAL_INSTANCE_MAX_DEPTH,
  normalizeMaterialDocument,
  normalizeMaterialInstanceDocument,
  type MaterialSource,
} from "@babylonslate/shader-graph";
import { isLegacyMaterialAssetType } from "@babylonslate/core";
import { useDocumentActions, useRegistryState } from "./document-context";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";

const decoder = new TextDecoder();

/**
 * Loads a Material Instance's parent chain up to its root Material. Open tabs
 * win over saved documents, so editing a parent updates the instance preview.
 * Returns null until the first load finishes.
 */
export function useMaterialInstanceSources(
  selfDocumentId: string,
  parentGuid: string | null,
): ReadonlyMap<string, MaterialSource> | null {
  const { readAssetChunk } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  // Only other open material tabs matter; the instance's own edits must not reload the chain.
  const openRef = useRef<ReadonlyArray<readonly [string, unknown]>>([]);
  const openMaterials = useMemo(() => {
    const next = materialDocuments
      .filter((entry) => entry.id !== selfDocumentId && entry.content)
      .map((entry) => [entry.ref.path, entry.content] as const);
    const previous = openRef.current;
    if (previous.length === next.length && next.every(([path, content], index) =>
      previous[index]![0] === path && previous[index]![1] === content)) return previous;
    openRef.current = next;
    return next;
  }, [materialDocuments, selfDocumentId]);
  const [sources, setSources] = useState<ReadonlyMap<string, MaterialSource> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      void registryEpoch; // Saved parents change without replacing the registry instance.
      const next = new Map<string, MaterialSource>();
      let guid = parentGuid;
      while (guid && !next.has(guid) && next.size <= MATERIAL_INSTANCE_MAX_DEPTH) {
        const asset = assetRegistry?.getByGuid(guid);
        if (!asset) break;
        let content = openMaterials.find(([path]) => path === asset.path)?.[1];
        if (content === undefined) {
          try {
            const bytes = await readAssetChunk(asset.path, "document", { ownerDocumentId: selfDocumentId });
            content = bytes?.length ? JSON.parse(decoder.decode(bytes)) : asset.header.payload;
          } catch {
            break;
          }
        }
        if (asset.header.type === "MaterialInstance") {
          const document = normalizeMaterialInstanceDocument(content, asset.header.name);
          next.set(guid, { kind: "instance", document });
          guid = document.parentGuid;
        } else if (asset.header.type === "Material" || isLegacyMaterialAssetType(asset.header.type)) {
          next.set(guid, { kind: "material", document: normalizeMaterialDocument(content, asset.header.name) });
          break;
        } else break;
      }
      if (!cancelled) setSources(next);
    })();
    return () => { cancelled = true; };
  }, [assetRegistry, openMaterials, parentGuid, readAssetChunk, registryEpoch, selfDocumentId]);

  return sources;
}
