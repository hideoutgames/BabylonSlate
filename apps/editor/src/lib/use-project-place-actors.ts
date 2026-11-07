import { useCallback, useMemo } from "react";
import type { SerializedGraph } from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { classGraphFromHeaderPayload } from "./logic-graph-document";
import {
  prefabComponentsResolver,
  projectPlaceActors,
  type PlaceActorItem,
} from "./place-actors";
import { prefabAssetTemplateKey, prefabAssetTemplates } from "./prefab-instance-sync";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const CLASS_KINDS = ["graph"] as const;
const PREFAB_KINDS = ["prefab"] as const;

/**
 * The project's placeable assets for a Scene (`overlay: false`) or Scene
 * Layer (`overlay: true`), each Class carrying its Prefab components from its
 * open tab or its registry header, the same rows Prefab sync reads. A Class
 * whose header lists no components resolves its graph when placed. Nothing is
 * built while disabled: `items` is then null. `graphForPath` reads the same
 * open tabs and headers.
 */
export function useProjectPlaceActors(options: { enabled: boolean; overlay: boolean }): {
  items: PlaceActorItem[] | null;
  graphForPath: (path: string) => SerializedGraph | undefined;
} {
  const { enabled, overlay } = options;
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const prefabDocuments = useOpenDocumentsOfKinds(PREFAB_KINDS);

  // Closed Classes by path, from their headers: no Class is read from disk to list or place them.
  const headerGraphs = useMemo(() => {
    if (!enabled) return null;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const graphs = new Map<string, SerializedGraph>();
    for (const asset of assetRegistry?.list() ?? []) {
      if (asset.header.type === "Class" && asset.path) graphs.set(asset.path, classGraphFromHeaderPayload(asset.header.payload));
    }
    return graphs;
  }, [assetRegistry, enabled, registryEpoch]);

  const openClassDocuments = useMemo(() => {
    const byPath = new Map<string, (typeof classDocuments)[number]>();
    for (const entry of classDocuments) {
      if (!byPath.has(entry.ref.path)) byPath.set(entry.ref.path, entry);
    }
    return byPath;
  }, [classDocuments]);

  const graphForPath = useCallback(
    (path: string): SerializedGraph | undefined => {
      const open = openClassDocuments.get(path);
      if (open?.content) return open.content as SerializedGraph;
      return headerGraphs?.get(path);
    },
    [headerGraphs, openClassDocuments],
  );

  const items = useMemo(() => {
    if (!enabled) return null;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const assets = assetRegistry?.list() ?? [];
    // Prefab assets carry their components in the header; open tabs win.
    const prefabAssets = prefabAssetTemplates({ assets, openDocuments: prefabDocuments });
    const classPrefab = prefabComponentsResolver({ assets, graphForPath });
    return projectPlaceActors(
      assets,
      (guid) => prefabAssets[prefabAssetTemplateKey(guid)] ?? classPrefab(guid),
      { overlay },
    );
  }, [assetRegistry, enabled, graphForPath, overlay, prefabDocuments, registryEpoch]);

  return { items, graphForPath };
}
