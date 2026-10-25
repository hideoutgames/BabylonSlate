import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { resolvePluginEnabled, type IndexedAsset } from "@haptic/assets";
import type { TypeVisual } from "@haptic/editor-kit";
import type { useProjectState, useRegistryState } from "../context/document-context";
import { resolvePluginIcon } from "../lib/plugin-icons";
import {
  ASSETS_ROOT,
  classParentLookup,
  collectFolderGuidsFromTrees,
  filterAssets,
  flattenFolderForest,
  listChildFoldersFromTrees,
  sortAssets,
  sortChildFolders,
  uniqueAssetTypes,
  visualForIndexedAsset,
  type ContentBrowserSortMode,
} from "../lib/content-browser-helpers";
import {
  canMutateContentBrowserRoot,
  contentBrowserFolderOps,
  contentBrowserRoots,
  isPluginContentFolderPath,
  PROJECT_CONTENT_ROOT_ID,
} from "../lib/plugin-ui";
import type { ContentBrowserGridItem } from "./content-browser-grid-tiles";

type RegistryState = ReturnType<typeof useRegistryState>;

/** What the Content Browser's derived model reads. */
export interface ContentBrowserModelDeps {
  assetRegistry: RegistryState["assetRegistry"];
  /** Advances on every index change; the memos list it because the registry mutates in place. */
  registryEpoch: RegistryState["registryEpoch"];
  pluginDescriptors: RegistryState["pluginDescriptors"];
  showPluginContent: RegistryState["showPluginContent"];
  projectDocument: ReturnType<typeof useProjectState>["projectDocument"];
  selectedFolderPath: string;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  search: string;
  typeFilters: string[];
  sortMode: ContentBrowserSortMode;
}

/**
 * Content roots, folder trees and assets, and the grid items the open folder
 * shows under the search, type filters and sort.
 */
export function useContentBrowserModel(deps: ContentBrowserModelDeps) {
  const {
    assetRegistry,
    registryEpoch,
    pluginDescriptors,
    showPluginContent,
    projectDocument,
    selectedFolderPath,
    setSelectedFolderPath,
    search,
    typeFilters,
    sortMode,
  } = deps;
  const browserRoots = useMemo(
    () =>
      contentBrowserRoots({
        showPluginContent,
        plugins: pluginDescriptors.map((plugin) => ({
          pluginGuid: plugin.pluginGuid,
          displayName: plugin.settings.displayName,
          contentPath: plugin.contentPath,
          source: plugin.source,
          enabled: resolvePluginEnabled(
            plugin.settings.enabledByDefault,
            projectDocument?.settings.pluginOverrides[plugin.pluginGuid]
              ?.enabled,
          ),
        })),
      }),
    [pluginDescriptors, projectDocument, showPluginContent],
  );
  const rootPrefixes = useMemo(
    () => browserRoots.map((root) => root.pathPrefix),
    [browserRoots],
  );
  const readOnlyRootPrefixes = useMemo(
    () => browserRoots.filter((root) => root.readOnly).map((root) => root.pathPrefix),
    [browserRoots],
  );
  const pluginContentPrefixes = useMemo(
    () => pluginDescriptors.map((plugin) => plugin.contentPath),
    [pluginDescriptors],
  );
  const pluginRootIcons = useMemo(
    () => new Map(pluginDescriptors.map((plugin) => [
      plugin.contentPath,
      resolvePluginIcon(plugin.settings.iconKey),
    ])),
    [pluginDescriptors],
  );
  const selectedRoot = useMemo(
    () => contentBrowserFolderOps(selectedFolderPath, browserRoots),
    [browserRoots, selectedFolderPath],
  );
  const selectedRootWritable = canMutateContentBrowserRoot(
    browserRoots.find((root) => root.id === selectedRoot.rootId),
  );
  const folderRoot = browserRoots.find((root) => root.id === selectedRoot.rootId) ?? browserRoots[0]!;
  const isReadOnlyFolder = useCallback(
    (path: string) => contentBrowserFolderOps(path, browserRoots).readOnly,
    [browserRoots],
  );

  // Layout effects, so a reveal that is not a discrete event (closing a
  // dirty tab after Save) never paints a folder the browser is about to leave.
  useLayoutEffect(() => {
    if (
      !showPluginContent &&
      isPluginContentFolderPath(selectedFolderPath, pluginContentPrefixes)
    ) {
      setSelectedFolderPath(ASSETS_ROOT);
    }
  }, [pluginContentPrefixes, selectedFolderPath, setSelectedFolderPath, showPluginContent]);

  const folderTrees = useMemo(() => {
    if (!assetRegistry) return [];
    return browserRoots.flatMap((root) => {
      if (!assetRegistry.getRoot(root.id)) return [];
      const tree = assetRegistry.folderTree(root.id);
      return [
        {
          ...tree,
          name:
            root.id === PROJECT_CONTENT_ROOT_ID
              ? tree.name
              : root.readOnly
                ? `${root.label} (Read Only)`
                : root.label,
        },
      ];
    });
  }, [assetRegistry, browserRoots, registryEpoch]);

  const allAssets = useMemo(() => {
    if (!assetRegistry) return [];
    return browserRoots.flatMap((root) => {
      if (!assetRegistry.getRoot(root.id)) return [];
      return assetRegistry.list({ rootId: root.id });
    });
  }, [assetRegistry, browserRoots, registryEpoch]);

  const referenceAssets = useMemo(
    () => {
      void registryEpoch;
      return assetRegistry?.list() ?? [];
    },
    [assetRegistry, registryEpoch],
  );
  const assetsByGuid = useMemo(
    () => new Map(allAssets.map((asset) => [asset.header.guid, asset])),
    [allAssets],
  );

  const classParentOf = useMemo(
    () => classParentLookup(allAssets),
    [allAssets],
  );

  /** One type visual per asset object while the class ancestry is unchanged. */
  const typeVisualFor = useMemo(() => {
    const visuals = new WeakMap<IndexedAsset, TypeVisual>();
    return (asset: IndexedAsset): TypeVisual => {
      let visual = visuals.get(asset);
      if (!visual) {
        visual = visualForIndexedAsset(asset, classParentOf);
        visuals.set(asset, visual);
      }
      return visual;
    };
  }, [classParentOf]);

  const folderGuids = useMemo(() => {
    if (folderTrees.length === 0) return null;
    return collectFolderGuidsFromTrees(selectedFolderPath, folderTrees);
  }, [folderTrees, selectedFolderPath]);

  // Typing updates the field at once; the grid follows at low priority.
  // Clearing the search (Clear Filters, revealing an asset) applies in the same
  // render as the folder and type filters that change with it.
  const deferredSearch = useDeferredValue(search);
  const gridSearch = search.trim() ? deferredSearch : search;
  const searchPending = search !== gridSearch;

  // Sort once per list and mode. Filtering keeps that order, and the sort is a
  // total order, so each keystroke only filters.
  const sortedAssets = useMemo(
    () => sortAssets(allAssets, sortMode),
    [allAssets, sortMode],
  );

  const visibleAssets = useMemo(
    () =>
      filterAssets(sortedAssets, {
        folderGuids,
        typeFilters,
        search: gridSearch,
      }),
    [gridSearch, folderGuids, sortedAssets, typeFilters],
  );

  const sortedChildFolders = useMemo(() => {
    if (folderTrees.length === 0) return [];
    return sortChildFolders(
      listChildFoldersFromTrees(folderTrees, selectedFolderPath),
      sortMode,
    );
  }, [folderTrees, selectedFolderPath, sortMode]);

  const childFolders = useMemo(() => {
    const needle = gridSearch.trim().toLowerCase();
    if (!needle) return sortedChildFolders;
    return sortedChildFolders.filter((folder) =>
      folder.name.toLowerCase().includes(needle),
    );
  }, [gridSearch, sortedChildFolders]);

  const gridItems = useMemo((): ContentBrowserGridItem[] => {
    const items: ContentBrowserGridItem[] = childFolders.map((folder) => ({
      kind: "folder",
      path: folder.path,
      name: folder.name,
    }));
    for (const asset of visibleAssets) {
      items.push({ kind: "asset", asset });
    }
    return items;
  }, [childFolders, visibleAssets]);

  const orderedTileHits = useMemo(
    () =>
      gridItems.map((item) =>
        item.kind === "folder"
          ? ({ kind: "folder" as const, path: item.path })
          : ({ kind: "asset" as const, guid: item.asset.header.guid }),
      ),
    [gridItems],
  );

  const existingAssetPaths = useMemo(
    () => allAssets.map((asset) => asset.path),
    [allAssets],
  );
  const existingFolderPaths = useMemo(
    () =>
      flattenFolderForest(folderTrees).map((row) => row.path),
    [folderTrees],
  );
  const existingContentPaths = useMemo(
    () => new Set([...existingAssetPaths, ...existingFolderPaths]),
    [existingAssetPaths, existingFolderPaths],
  );

  const typeChips = useMemo(() => uniqueAssetTypes(allAssets), [allAssets]);

  return {
    browserRoots,
    rootPrefixes,
    readOnlyRootPrefixes,
    pluginRootIcons,
    selectedRoot,
    selectedRootWritable,
    folderRoot,
    isReadOnlyFolder,
    folderTrees,
    allAssets,
    referenceAssets,
    assetsByGuid,
    classParentOf,
    typeVisualFor,
    gridSearch,
    searchPending,
    gridItems,
    orderedTileHits,
    existingAssetPaths,
    existingFolderPaths,
    existingContentPaths,
    typeChips,
  };
}
