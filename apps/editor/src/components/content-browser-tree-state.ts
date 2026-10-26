import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { FolderNode, IndexedAsset } from "@haptic/assets";
import {
  applyContentBrowserTreeSelect,
  flattenContentBrowserForest,
  withAutoCollapsedNestedFolders,
} from "../lib/content-browser-helpers";

/** What the Content Browser folder tree reads and selects through. */
export interface ContentBrowserTreeStateDeps {
  folderTrees: FolderNode[];
  allAssets: IndexedAsset[];
  assetsByGuid: ReadonlyMap<string, IndexedAsset>;
  selectedFolderPath: string;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  selectedGuids: Set<string>;
  setSelectedGuids: Dispatch<SetStateAction<Set<string>>>;
  selectedFolderPaths: Set<string>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
}

/** Folder tree rows, their collapse state, and tree selection with its Shift range anchor. */
export function useContentBrowserTreeState(deps: ContentBrowserTreeStateDeps) {
  const {
    folderTrees,
    allAssets,
    assetsByGuid,
    selectedFolderPath,
    setSelectedFolderPath,
    selectedGuids,
    setSelectedGuids,
    selectedFolderPaths,
    setSelectedFolderPaths,
  } = deps;
  /** Last tree row selected without a Shift range. */
  const [treeAnchorId, setTreeAnchorId] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const userToggledFoldersRef = useRef(new Set<string>());

  useLayoutEffect(() => {
    setCollapsedFolders((current) => {
      const next = withAutoCollapsedNestedFolders(
        current,
        folderTrees,
        userToggledFoldersRef.current,
      );
      if (next.size === current.size) {
        let same = true;
        for (const path of next) {
          if (!current.has(path)) {
            same = false;
            break;
          }
        }
        if (same) return current;
      }
      return next;
    });
  }, [folderTrees]);

  const browserRows = useMemo(() => {
    if (folderTrees.length === 0) return [];
    return flattenContentBrowserForest(folderTrees, allAssets, collapsedFolders);
  }, [allAssets, collapsedFolders, folderTrees]);

  /** Primary tree row and Shift range anchor: the last clicked row while it stays selected. */
  const treeSelectedId = useMemo(() => {
    if (treeAnchorId && (selectedFolderPaths.has(treeAnchorId) ||
      [...selectedGuids].some((guid) => assetsByGuid.get(guid)?.path === treeAnchorId))) {
      return treeAnchorId;
    }
    if (selectedGuids.size === 1) {
      const guid = [...selectedGuids][0]!;
      const asset = assetsByGuid.get(guid);
      if (asset) return asset.path;
    }
    return selectedFolderPath;
  }, [assetsByGuid, selectedFolderPath, selectedFolderPaths, selectedGuids, treeAnchorId]);

  const treeSelectedIds = useMemo(() => {
    const ids: string[] = [...selectedFolderPaths];
    for (const guid of selectedGuids) {
      const asset = assetsByGuid.get(guid);
      if (asset) ids.push(asset.path);
    }
    if (ids.length === 0 && treeSelectedId) ids.push(treeSelectedId);
    return ids;
  }, [assetsByGuid, selectedFolderPaths, selectedGuids, treeSelectedId]);

  const handleTreeSelect = useCallback(
    (id: string, options?: { additive?: boolean; range?: boolean }) => {
      const next = applyContentBrowserTreeSelect(id, options, browserRows, {
        selectedGuids,
        selectedFolderPaths,
        selectedFolderPath,
        anchorId: treeSelectedId,
      });
      setSelectedGuids(next.selectedGuids);
      setSelectedFolderPaths(next.selectedFolderPaths);
      setSelectedFolderPath(next.selectedFolderPath);
      if (!options?.range) setTreeAnchorId(id);
    },
    [
      browserRows,
      selectedFolderPath,
      selectedFolderPaths,
      selectedGuids,
      treeSelectedId,
      setSelectedFolderPath,
      setSelectedFolderPaths,
      setSelectedGuids,
    ],
  );

  /** Expands or collapses a folder row; auto-collapse then keeps the user's choice. */
  const toggleFolderExpanded = (id: string) => {
    const row = browserRows.find((item) => item.id === id);
    if (!row || row.kind !== "folder" || !row.hasChildren) return;
    userToggledFoldersRef.current.add(id);
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return { browserRows, treeSelectedId, treeSelectedIds, handleTreeSelect, toggleFolderExpanded };
}
