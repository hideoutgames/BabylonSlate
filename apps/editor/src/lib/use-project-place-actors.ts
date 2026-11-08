import { useCallback, useMemo } from "react";
import type { SerializedGraph } from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  prefabComponentsResolver,
  projectPlaceActors,
  type PlaceActorItem,
} from "./place-actors";
import { prefabAssetTemplateKey, prefabAssetTemplates } from "./prefab-instance-sync";
import { useClassGraphs } from "./use-class-graphs";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const PREFAB_KINDS = ["prefab"] as const;

/**
 * The project's placeable assets for a Scene (`overlay: false`) or Scene
 * Layer (`overlay: true`), each Class carrying its Prefab components from its
 * open tab or its header rows, as Prefab sync reads them; a Class whose header
 * has no rows loads its graph when placed (`usePlaceActorItems`). Nothing is
 * built while disabled: `items` is then null. `graphForPath` reads the same
 * open and header graphs.
 */
export function useProjectPlaceActors(options: { enabled: boolean; overlay: boolean }): {
  items: PlaceActorItem[] | null;
  graphForPath: (path: string) => SerializedGraph | undefined;
} {
  const { enabled, overlay } = options;
  const { assetRegistry, registryEpoch } = useRegistryState();
  const prefabDocuments = useOpenDocumentsOfKinds(PREFAB_KINDS);
  const classGraphs = useClassGraphs();

  const graphForPath = useCallback(
    (path: string): SerializedGraph | undefined => classGraphs[classIdForGraphPath(path)],
    [classGraphs],
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
