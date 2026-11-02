import { useCallback, useEffect, useMemo, useState } from "react";
import type { SerializedGraph } from "@haptic/core";
import { useDocumentActions, useRegistryState } from "../context/document-context";
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
 * open tab or, while `enabled`, its graph on disk. Every placeable asset and
 * Class graph is covered, so nothing is built or loaded while disabled:
 * `items` is then null. `graphForPath` reads the same open and loaded graphs.
 */
export function useProjectPlaceActors(options: { enabled: boolean; overlay: boolean }): {
  items: PlaceActorItem[] | null;
  graphForPath: (path: string) => SerializedGraph | undefined;
} {
  const { enabled, overlay } = options;
  const { loadGraphDocument } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const prefabDocuments = useOpenDocumentsOfKinds(PREFAB_KINDS);
  const [diskGraphs, setDiskGraphs] = useState<Map<string, SerializedGraph>>(() => new Map());

  // Loaded once per enable; a Class added later resolves its graph when placed.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const assets = assetRegistry?.list() ?? [];
    void (async () => {
      // Load the Classes together, so the slowest one sets the wait, not the sum.
      const loaded = await Promise.all(
        assets
          .filter((asset) => asset.header.type === "Class" && asset.path)
          .map(async (asset) => [asset.path, await loadGraphDocument(asset.path)] as const),
      );
      if (cancelled) return;
      const next = new Map<string, SerializedGraph>();
      for (const [path, graph] of loaded) if (graph) next.set(path, graph);
      setDiskGraphs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, enabled, loadGraphDocument]);

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
      return diskGraphs.get(path);
    },
    [diskGraphs, openClassDocuments],
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
