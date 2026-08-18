import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  ListFilterIcon,
  OctagonAlertIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import type { IndexedAsset } from "@babylonslate/assets";
import { newAssetGuid, resolvePluginEnabled } from "@babylonslate/assets";
import {
  ContextMenuOverlay,
  SearchInput,
  SelectableText,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  useContextMenu,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { documentId, documentKindForAssetType, labelFromPath, CONTENT_BROWSER_ID } from "@babylonslate/core";
import { isMobilePlatform, pickImportFiles } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { Input } from "@babylonslate/ui/components/input";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@babylonslate/ui/components/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { useDocuments } from "../context/document-context";
import {
  applyLockTransfers,
  containedAssetPaths,
  folderMoveLockTransfers,
  oursLockPaths,
  refuseTheirsPaths,
} from "../lib/source-control-file-ops";
import { useProjectSearch } from "../context/project-search-context";
import { useValidation } from "../context/validation-context";
import {
  ASSETS_ROOT,
  addSelectedAssetGuid,
  addSelectedFolderPath,
  exclusiveSelectAsset,
  exclusiveSelectFolder,
  applyContentBrowserTreeSelect,
  buildNewAssetResult,
  classParentLookup,
  collectFolderGuidsFromTrees,
  contentBrowserContextActions,
  contentBrowserDeleteListNames,
  contentBrowserDeletingGuids,
  contentBrowserMovePreviewName,
  contentBrowserTreeDropMoves,
  lastSceneClassDeleteLines,
  defaultParentClassForType,
  CONTENT_BROWSER_SORT_OPTIONS,
  displayAssetTitle,
  filterAssets,
  flattenContentBrowserForest,
  flattenFolderForest,
  guidsOutsideSelectedFolders,
  isFolderNameTaken,
  isFolderTreeRoot,
  isContentBrowserEmptyGridDoubleClickTarget,
  isNewAssetNameTaken,
  isRenameNameTaken,
  joinAssetFolderPath,
  listChildFoldersFromTrees,
  newAssetFileName,
  parentFolderPath,
  remapPathAfterFolderMove,
  rootSelectedFolderPaths,
  sortAssets,
  sortChildFolders,
  uniqueAssetTypes,
  visualForIndexedAsset,
  type ContentBrowserContextAction,
  type ContentBrowserDropMove,
  type ContentBrowserSortMode,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import {
  canMutateContentBrowserRoot,
  contentBrowserFolderOps,
  contentBrowserRoots,
  filterBabpluginFiles,
  isPluginContentFolderPath,
  PROJECT_CONTENT_ROOT_ID,
} from "../lib/plugin-ui";
import { revealAssetFromTarget } from "../lib/search-navigation";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { useContentBrowserPaintSelect } from "../lib/use-content-browser-paint-select";
import { contentBrowserTileStyle } from "../lib/content-browser-grid";
import { syncContentBrowserThumbnailUrls } from "../lib/content-browser-thumbnails";
import { useContentBrowserGridWindow } from "../lib/use-content-browser-grid-window";
import { ContentBrowserAssetTile } from "./content-browser-asset-tile";
import { ContentBrowserFolderTile } from "./content-browser-folder-tile";
import { ContentBrowserMoveDialog } from "./content-browser-move-dialog";
import { ContentBrowserNewAssetDialog } from "./content-browser-new-asset-dialog";
import { ContentBrowserSelectionActions } from "./content-browser-selection-actions";

const PROJECT_ROOT_ID = PROJECT_CONTENT_ROOT_ID;

type DeleteTarget =
  | { kind: "assets"; guids: string[] }
  | { kind: "folder"; path: string; guids: string[] }
  | { kind: "selection"; folders: string[]; guids: string[] };

type MoveTarget = {
  operation: "move" | "copy";
  kind: "asset" | "folder";
  guids: string[];
  folderPaths: string[];
  name: string;
  sourcePath: string;
  folderPath: string;
  assetSourcePaths: string[];
  folderSourcePaths: string[];
  itemCount: number;
  typeVisual: TypeVisual | null;
};

export function ContentBrowserWorkspace({
  hidden = false,
}: {
  hidden?: boolean;
} = {}) {
  const {
    projectDocument,
    assetRegistry,
    registryVersion,
    refreshAssetRegistry,
    repathDocument,
    openDocument,
    openDocuments,
    setActiveDocument,
    tabOrder,
    loadAssetThumbnail,
    thumbnailsEnabled,
    pluginDescriptors,
    showPluginContent,
    sourceControl,
    activeDocumentId,
  } = useDocuments();
  const { pendingTarget, clearPendingTarget } = useProjectSearch();
  const { diagnostics } = useValidation();
  const compileErrorGuids = useMemo(() => {
    const set = new Set<string>();
    for (const d of diagnostics) {
      if (d.severity === "error") set.add(d.assetGuid);
    }
    return set;
  }, [diagnostics]);

  useEffect(() => {
    if (activeDocumentId !== CONTENT_BROWSER_ID) return;
    if (!sourceControl.enabled) return;
    sourceControl.requestRefresh();
  }, [activeDocumentId, sourceControl, sourceControl.enabled]);

  const [selectedFolderPath, setSelectedFolderPath] = useState(ASSETS_ROOT);
  const [search, setSearch] = useState("");
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<ContentBrowserSortMode>("name-asc");
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set());
  const [selectedFolderPaths, setSelectedFolderPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [newAssetOpen, setNewAssetOpen] = useState(false);
  const [newAssetType, setNewAssetType] =
    useState<CreatableAssetType>("Scene");
  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetParent, setNewAssetParent] = useState("BObject");
  const [busy, setBusy] = useState(false);
  const [nameDialog, setNameDialog] = useState<
    | { kind: "rename"; guid: string; value: string }
    | { kind: "folder"; value: string }
    | { kind: "rename-folder"; path: string; value: string }
    | null
  >(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [refsSummary, setRefsSummary] = useState<{
    name: string;
    inbound: string;
    outbound: string;
  } | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
    {},
  );
  const [importProgress, setImportProgress] = useState<{
    total: number;
    done: number;
    currentName: string;
  } | null>(null);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const thumbnailUrlsRef = useRef(thumbnailUrls);
  thumbnailUrlsRef.current = thumbnailUrls;
  const menuTargetGuidsRef = useRef<string[]>([]);
  const menuTargetFoldersRef = useRef<string[]>([]);

  useEffect(() => {
    if (!pendingTarget) return;
    const reveal = revealAssetFromTarget(pendingTarget);
    if (!reveal) return;
    const folder = reveal.path.includes("/")
      ? reveal.path.slice(0, reveal.path.lastIndexOf("/"))
      : ASSETS_ROOT;
    setSelectedFolderPath(folder || ASSETS_ROOT);
    setTypeFilters([]);
    setSearch("");
    setSelectedGuids(new Set([reveal.guid]));
    setSelectedFolderPaths(new Set());
    clearPendingTarget();
  }, [clearPendingTarget, pendingTarget]);

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
  const pluginContentPrefixes = useMemo(
    () => pluginDescriptors.map((plugin) => plugin.contentPath),
    [pluginDescriptors],
  );
  const selectedRoot = useMemo(
    () => contentBrowserFolderOps(selectedFolderPath, browserRoots),
    [browserRoots, selectedFolderPath],
  );
  const selectedRootWritable = canMutateContentBrowserRoot(
    browserRoots.find((root) => root.id === selectedRoot.rootId),
  );

  useEffect(() => {
    if (
      !showPluginContent &&
      isPluginContentFolderPath(selectedFolderPath, pluginContentPrefixes)
    ) {
      setSelectedFolderPath(ASSETS_ROOT);
    }
  }, [pluginContentPrefixes, selectedFolderPath, showPluginContent]);

  const folderTrees = useMemo(() => {
    if (!assetRegistry) return [];
    return browserRoots.flatMap((root) => {
      if (!assetRegistry.getRoot(root.id)) return [];
      const tree = assetRegistry.folderTree(root.id);
      return [
        {
          ...tree,
          name:
            root.id === PROJECT_ROOT_ID
              ? tree.name
              : root.readOnly
                ? `${root.label} (Read Only)`
                : root.label,
        },
      ];
    });
  }, [assetRegistry, browserRoots, registryVersion]);

  const allAssets = useMemo(() => {
    if (!assetRegistry) return [];
    return browserRoots.flatMap((root) => {
      if (!assetRegistry.getRoot(root.id)) return [];
      return assetRegistry.list({ rootId: root.id });
    });
  }, [assetRegistry, browserRoots, registryVersion]);

  const refuseTheirsAssetPaths = useCallback(
    (paths: string[]): boolean => {
      const locked = refuseTheirsPaths(paths, (path) =>
        sourceControl.refuseIfTheirs(path),
      );
      if (locked) {
        setOpenError(locked);
        return true;
      }
      return false;
    },
    [sourceControl],
  );

  const transferFolderLocks = useCallback(
    async (fromPath: string, nextFolder: string) => {
      await applyLockTransfers(
        folderMoveLockTransfers(allAssets, fromPath, nextFolder),
        (path) => sourceControl.lockStateForPath(path),
        (from, to) => sourceControl.transferLock(from, to),
      );
    },
    [allAssets, sourceControl],
  );

  const classParentOf = useMemo(
    () => classParentLookup(allAssets),
    [allAssets],
  );

  const folderGuids = useMemo(() => {
    if (folderTrees.length === 0) return null;
    return collectFolderGuidsFromTrees(selectedFolderPath, folderTrees);
  }, [folderTrees, selectedFolderPath]);

  const visibleAssets = useMemo(
    () =>
      sortAssets(
        filterAssets(allAssets, {
          folderGuids,
          typeFilters,
          search,
        }),
        sortMode,
      ),
    [allAssets, folderGuids, search, sortMode, typeFilters],
  );

  const childFolders = useMemo(() => {
    if (folderTrees.length === 0) return [];
    const folders = listChildFoldersFromTrees(folderTrees, selectedFolderPath);
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? folders.filter((folder) => folder.name.toLowerCase().includes(needle))
      : folders;
    return sortChildFolders(matched, sortMode);
  }, [folderTrees, search, selectedFolderPath, sortMode]);

  type GridItem =
    | { kind: "folder"; path: string; name: string }
    | { kind: "asset"; asset: IndexedAsset };

  const gridItems = useMemo((): GridItem[] => {
    const items: GridItem[] = childFolders.map((folder) => ({
      kind: "folder",
      path: folder.path,
      name: folder.name,
    }));
    for (const asset of visibleAssets) {
      items.push({ kind: "asset", asset });
    }
    return items;
  }, [childFolders, visibleAssets]);

  const { scrollerRef, slice, spacerHeight } = useContentBrowserGridWindow(
    gridItems.length,
    hidden,
  );

  const mountedTextureGuids = useMemo(() => {
    const guids: string[] = [];
    for (let index = slice.firstIndex; index < slice.lastIndex; index++) {
      const item = gridItems[index];
      if (item?.kind === "asset" && item.asset.header.type === "Texture") {
        guids.push(item.asset.header.guid);
      }
    }
    return guids;
  }, [gridItems, slice.firstIndex, slice.lastIndex]);

  const browserRows = useMemo(() => {
    if (folderTrees.length === 0) return [];
    return flattenContentBrowserForest(folderTrees, allAssets, collapsedFolders);
  }, [allAssets, collapsedFolders, folderTrees]);

  const treeSelectedId = useMemo(() => {
    if (selectedGuids.size === 1) {
      const guid = [...selectedGuids][0]!;
      const asset = allAssets.find((item) => item.header.guid === guid);
      if (asset) return asset.path;
    }
    return selectedFolderPath;
  }, [allAssets, selectedFolderPath, selectedGuids]);

  const treeSelectedIds = useMemo(() => {
    const ids: string[] = [...selectedFolderPaths];
    for (const guid of selectedGuids) {
      const asset = allAssets.find((item) => item.header.guid === guid);
      if (asset) ids.push(asset.path);
    }
    if (ids.length === 0 && treeSelectedId) ids.push(treeSelectedId);
    return ids;
  }, [allAssets, selectedFolderPaths, selectedGuids, treeSelectedId]);

  const treeNodes = useMemo(
    () =>
      browserRows.map((row) => {
        const asset = row.guid
          ? allAssets.find((item) => item.header.guid === row.guid)
          : undefined;
        return {
          id: row.id,
          label: row.label,
          depth: row.depth,
          hasChildren: row.hasChildren,
          expanded: row.expanded,
          icon:
            row.kind === "folder" ? (
              <FolderIcon />
            ) : asset ? (
              <TypeVisualIcon
                visual={visualForIndexedAsset(asset, classParentOf)}
              />
            ) : undefined,
        };
      }),
    [allAssets, browserRows, classParentOf],
  );

  const selectionCount = selectedGuids.size + selectedFolderPaths.size;

  const existingAssetPaths = useMemo(
    () => allAssets.map((asset) => asset.path),
    [allAssets],
  );
  const existingFolderPaths = useMemo(
    () =>
      flattenFolderForest(folderTrees).map((row) => row.path),
    [folderTrees],
  );
  const newAssetNameTaken = isNewAssetNameTaken(
    existingAssetPaths,
    selectedFolderPath,
    newAssetType,
    newAssetName,
  );
  const nameDialogTaken =
    nameDialog?.kind === "folder"
      ? isFolderNameTaken(
          existingFolderPaths,
          selectedFolderPath,
          nameDialog.value,
        )
      : nameDialog?.kind === "rename-folder"
        ? (() => {
            const parent = parentFolderPath(nameDialog.path);
            const next = joinAssetFolderPath(parent, nameDialog.value.trim());
            if (next === nameDialog.path) return false;
            return isFolderNameTaken(
              existingFolderPaths,
              parent,
              nameDialog.value,
            );
          })()
      : nameDialog?.kind === "rename" && assetRegistry
        ? isRenameNameTaken(
            existingAssetPaths,
            assetRegistry.getByGuid(nameDialog.guid)?.path ?? "",
            nameDialog.value,
          )
        : false;

  useEffect(() => {
    if (!thumbnailsEnabled) return;
    let cancelled = false;
    void (async () => {
      const next = await syncContentBrowserThumbnailUrls({
        mountedTextureGuids,
        urls: thumbnailUrlsRef.current,
        hidden,
        load: loadAssetThumbnail,
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      });
      if (!cancelled) setThumbnailUrls(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [hidden, loadAssetThumbnail, mountedTextureGuids, thumbnailsEnabled]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(thumbnailUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const typeChips = useMemo(() => uniqueAssetTypes(allAssets), [allAssets]);

  const openIds = useMemo(() => new Set(tabOrder), [tabOrder]);

  const openOrFocusDocument = useCallback(
    async (asset: IndexedAsset) => {
      const kind = documentKindForAssetType(asset.header.type);
      if (!kind) return;
      const path = asset.path;
      const id = documentId({ kind, path });
      if (openIds.has(id)) {
        setActiveDocument(id);
        return;
      }
      try {
        await openDocument({
          kind,
          path,
          label: labelFromPath(path),
        });
      } catch (error) {
        setOpenError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [openDocument, openIds, setActiveDocument],
  );

  const requestDelete = useCallback((guids: string[]) => {
    if (guids.length === 0) return;
    setDeleteTarget({ kind: "assets", guids });
  }, []);

  const requestDeleteFolder = useCallback(
    (path: string) => {
      if (folderTrees.length === 0 || isFolderTreeRoot(path, rootPrefixes)) {
        return;
      }
      const guids = [
        ...collectFolderGuidsFromTrees(path, folderTrees, { recursive: true }),
      ];
      setDeleteTarget({ kind: "folder", path, guids });
    },
    [folderTrees, rootPrefixes],
  );

  const requestDeleteSnapshot = useCallback(
    (guids: string[], folderPaths: string[]) => {
      const folders = folderPaths.filter(
        (path) => !isFolderTreeRoot(path, rootPrefixes),
      );
      if (folderTrees.length === 0) {
        requestDelete(guids);
        return;
      }
      if (folders.length === 0) {
        requestDelete(guids);
        return;
      }
      const folderGuidsSet = new Set<string>();
      for (const path of folders) {
        for (const guid of collectFolderGuidsFromTrees(path, folderTrees, {
          recursive: true,
        })) {
          folderGuidsSet.add(guid);
        }
      }
      const extraGuids = guids.filter((guid) => !folderGuidsSet.has(guid));
      if (folders.length === 1 && extraGuids.length === 0) {
        requestDeleteFolder(folders[0]!);
        return;
      }
      setDeleteTarget({
        kind: "selection",
        folders,
        guids: extraGuids,
      });
    },
    [folderTrees, requestDelete, requestDeleteFolder, rootPrefixes],
  );

  const requestDeleteSelection = useCallback(() => {
    requestDeleteSnapshot([...selectedGuids], [...selectedFolderPaths]);
  }, [requestDeleteSnapshot, selectedFolderPaths, selectedGuids]);

  const repairDocumentPath = useCallback(
    (oldPath: string, newPath: string, type: string) => {
      if (oldPath === newPath) return;
      if (type === "Scene") repathDocument("scene", oldPath, newPath);
      const kind = documentKindForAssetType(type);
      if (kind && kind !== "scene") repathDocument(kind, oldPath, newPath);
    },
    [repathDocument],
  );

  const openMoveForSnapshot = useCallback(
    (operation: "move" | "copy") => {
      if (!assetRegistry) return;
      const folders = rootSelectedFolderPaths(
        menuTargetFoldersRef.current.filter(
          (path) => !isFolderTreeRoot(path, rootPrefixes),
        ),
      );
      const guids = guidsOutsideSelectedFolders(
        menuTargetGuidsRef.current,
        folders,
        (guid) => assetRegistry.getByGuid(guid)?.path,
      );
      if (folders.length + guids.length === 0) return;
      const names: string[] = [];
      const assetSourcePaths: string[] = [];
      for (const path of folders) {
        names.push(path.slice(path.lastIndexOf("/") + 1));
      }
      let typeVisual: TypeVisual | null = null;
      for (const guid of guids) {
        const asset = assetRegistry.getByGuid(guid);
        if (!asset) continue;
        names.push(displayAssetTitle(asset.header.name));
        const folderPath = parentFolderPath(asset.path);
        if (!assetSourcePaths.includes(folderPath)) {
          assetSourcePaths.push(folderPath);
        }
        if (guids.length === 1 && folders.length === 0) {
          typeVisual = visualForIndexedAsset(asset, classParentOf);
        }
      }
      const sourcePath =
        folders[0] ?? assetSourcePaths[0] ?? selectedFolderPath;
      setMoveTarget({
        operation,
        kind: folders.length > 0 && guids.length === 0 ? "folder" : "asset",
        guids,
        folderPaths: folders,
        name: contentBrowserMovePreviewName(names),
        sourcePath,
        folderPath: sourcePath,
        assetSourcePaths,
        folderSourcePaths: folders,
        itemCount: folders.length + guids.length,
        typeVisual,
      });
    },
    [assetRegistry, classParentOf, selectedFolderPath],
  );

  const tileContextItems = useMemo(
    () => [
      {
        id: "duplicate" as const,
        label: "Duplicate",
        onSelect: () => {
          void (async () => {
            if (!assetRegistry) return;
            const folders = rootSelectedFolderPaths(
              menuTargetFoldersRef.current.filter(
                (path) => !isFolderTreeRoot(path, rootPrefixes),
              ),
            );
            const guids = guidsOutsideSelectedFolders(
              menuTargetGuidsRef.current,
              folders,
              (guid) => assetRegistry.getByGuid(guid)?.path,
            );
            const browse = contentBrowserFolderOps(
              selectedFolderPath,
              browserRoots,
            );
            if (browse.readOnly) return;
            for (const path of folders) {
              const from = contentBrowserFolderOps(path, browserRoots);
              await assetRegistry.duplicateFolder(from.rootId, from.relative);
            }
            for (const guid of guids) {
              await assetRegistry.duplicateAsset(
                guid,
                browse.rootId,
                browse.relative,
              );
            }
            await refreshAssetRegistry();
          })();
        },
      },
      {
        id: "rename" as const,
        label: "Rename",
        onSelect: () => {
          const folders = menuTargetFoldersRef.current.filter(
            (path) => !isFolderTreeRoot(path, rootPrefixes),
          );
          const guids = menuTargetGuidsRef.current;
          if (folders.length === 1 && guids.length === 0) {
            const path = folders[0]!;
            setNameDialog({
              kind: "rename-folder",
              path,
              value: path.slice(path.lastIndexOf("/") + 1),
            });
            return;
          }
          const guid = guids[0];
          if (!guid || !assetRegistry) return;
          const asset = assetRegistry.getByGuid(guid);
          if (!asset) return;
          setNameDialog({
            kind: "rename",
            guid,
            value: asset.header.name,
          });
        },
      },
      {
        id: "move" as const,
        label: "Move…",
        onSelect: () => openMoveForSnapshot("move"),
      },
      {
        id: "copy" as const,
        label: "Copy to Folder…",
        onSelect: () => openMoveForSnapshot("copy"),
      },
      {
        id: "show-references" as const,
        label: "Show References",
        onSelect: () => {
          const guid = menuTargetGuidsRef.current[0];
          if (!guid || !assetRegistry) return;
          const refs = assetRegistry.showReferences(guid);
          const inbound = refs.inbound
            .map((id) => assetRegistry.getByGuid(id)?.header.name ?? id)
            .join(", ");
          const outbound = refs.outbound
            .map((id) => assetRegistry.getByGuid(id)?.header.name ?? id)
            .join(", ");
          setRefsSummary({
            name: assetRegistry.getByGuid(guid)?.header.name ?? guid,
            inbound: inbound || "(none)",
            outbound: outbound || "(none)",
          });
        },
      },
      {
        id: "delete" as const,
        label: "Delete",
        onSelect: () =>
          requestDeleteSnapshot(
            menuTargetGuidsRef.current,
            menuTargetFoldersRef.current,
          ),
      },
    ],
    [
      assetRegistry,
      openMoveForSnapshot,
      refreshAssetRegistry,
      requestDeleteSnapshot,
      selectedFolderPath,
    ],
  );

  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: tileContextItems,
  });

  const resolveAssetName = useCallback(
    (guid: string) =>
      assetRegistry?.getByGuid(guid)?.header.name ?? guid,
    [assetRegistry],
  );

  const deleteInboundRefs = useMemo(() => {
    if (!deleteTarget || !assetRegistry) return [];
    const refs = new Set<string>();
    for (const guid of deleteTarget.guids) {
      for (const inbound of assetRegistry.showReferences(guid).inbound) {
        if (!deleteTarget.guids.includes(inbound)) {
          refs.add(inbound);
        }
      }
    }
    return [...refs].map((guid) => ({
      guid,
      name: resolveAssetName(guid),
    }));
  }, [assetRegistry, deleteTarget, resolveAssetName]);

  const deleteListNames = useMemo(() => {
    if (!deleteTarget) return [];
    if (deleteTarget.kind === "folder") {
      return contentBrowserDeleteListNames({
        folderPaths: [deleteTarget.path],
      });
    }
    const assetNames = deleteTarget.guids.map(resolveAssetName);
    if (deleteTarget.kind === "selection") {
      return contentBrowserDeleteListNames({
        folderPaths: deleteTarget.folders,
        assetNames,
      });
    }
    return contentBrowserDeleteListNames({ assetNames });
  }, [deleteTarget, resolveAssetName]);

  const deleteLastSceneClassLines = useMemo(() => {
    if (!deleteTarget) return [];
    const folderPaths =
      deleteTarget.kind === "folder"
        ? [deleteTarget.path]
        : deleteTarget.kind === "selection"
          ? deleteTarget.folders
          : [];
    return lastSceneClassDeleteLines(
      allAssets,
      contentBrowserDeletingGuids({
        extraGuids: deleteTarget.guids,
        folderPaths,
        assets: allAssets,
      }),
    );
  }, [allAssets, deleteTarget]);

  const confirmDelete = useCallback(async () => {
    if (!assetRegistry || !deleteTarget) return;
    const paths = new Set<string>();
    for (const guid of deleteTarget.guids) {
      const path = assetRegistry.getByGuid(guid)?.path;
      if (path) paths.add(path);
    }
    const folders =
      deleteTarget.kind === "folder"
        ? [deleteTarget.path]
        : deleteTarget.kind === "selection"
          ? deleteTarget.folders
          : [];
    for (const folder of folders) {
      for (const path of containedAssetPaths(allAssets, folder)) {
        paths.add(path);
      }
    }
    if (refuseTheirsAssetPaths([...paths])) return;
    const oursToRelease = oursLockPaths([...paths], (path) =>
      sourceControl.lockStateForPath(path),
    );
    setBusy(true);
    try {
      for (const path of folders) {
        const from = contentBrowserFolderOps(path, browserRoots);
        if (from.readOnly) continue;
        await assetRegistry.deleteFolder(from.rootId, from.relative);
        setSelectedFolderPath((current) =>
          current === path || current.startsWith(`${path}/`)
            ? parentFolderPath(path, from.pathPrefix)
            : current,
        );
      }
      if (deleteTarget.kind !== "folder") {
        for (const guid of deleteTarget.guids) {
          if (assetRegistry.getByGuid(guid)) {
            await assetRegistry.deleteAsset(guid);
          }
        }
      }
      setSelectedGuids(new Set());
      setSelectedFolderPaths(new Set());
      setDeleteTarget(null);
      for (const path of oursToRelease) {
        await sourceControl.releasePath(path);
      }
      await refreshAssetRegistry();
    } finally {
      setBusy(false);
    }
  }, [
    allAssets,
    assetRegistry,
    browserRoots,
    deleteTarget,
    refreshAssetRegistry,
    refuseTheirsAssetPaths,
    sourceControl,
  ]);

  const importPickedFiles = useCallback(
    async (files: Array<{ name: string; bytes: Uint8Array }>) => {
      if (!assetRegistry || !files.length || selectedRoot.readOnly) return;
      const errors: string[] = [];
      const incoming = filterBabpluginFiles(files);
      if (incoming.length === 0) return;
      setBusy(true);
      setImportProgress({
        total: incoming.length,
        done: 0,
        currentName: incoming[0]!.name,
      });
      try {
        const folder = selectedRoot.relative;
        for (let index = 0; index < incoming.length; index += 1) {
          const file = incoming[index]!;
          setImportProgress({
            total: incoming.length,
            done: index,
            currentName: file.name,
          });
          try {
            await assetRegistry.importFile(
              selectedRoot.rootId,
              folder,
              file.name,
              file.bytes,
            );
          } catch (err) {
            errors.push(
              `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          setImportProgress({
            total: incoming.length,
            done: index + 1,
            currentName: file.name,
          });
        }
        await refreshAssetRegistry();
      } finally {
        setImportProgress(null);
        setBusy(false);
        if (errors.length) setImportErrors(errors);
      }
    },
    [assetRegistry, refreshAssetRegistry, selectedRoot],
  );

  const confirmNameDialog = useCallback(async () => {
    if (!assetRegistry || !nameDialog) return;
    setBusy(true);
    try {
      if (nameDialog.kind === "folder") {
        if (selectedRoot.readOnly) return;
        const relative = selectedRoot.relative
          ? `${selectedRoot.relative}/${nameDialog.value.trim()}`
          : nameDialog.value.trim();
        if (!relative) return;
        await assetRegistry.createFolder(selectedRoot.rootId, relative);
        await refreshAssetRegistry();
        setSelectedFolderPath(`${selectedRoot.pathPrefix}/${relative}`);
      } else if (nameDialog.kind === "rename-folder") {
        const fromPath = nameDialog.path;
        const from = contentBrowserFolderOps(fromPath, browserRoots);
        if (from.readOnly) return;
        const destPath = parentFolderPath(fromPath, from.pathPrefix);
        const dest = contentBrowserFolderOps(destPath, browserRoots);
        const newName = nameDialog.value.trim();
        if (!newName) return;
        const nextFolder = `${destPath}/${newName}`;
        const contained = allAssets.filter(
          (asset) =>
            asset.path === fromPath || asset.path.startsWith(`${fromPath}/`),
        );
        if (refuseTheirsAssetPaths(contained.map((asset) => asset.path))) {
          return;
        }
        await assetRegistry.moveFolder(
          from.rootId,
          from.relative,
          dest.relative,
          newName,
        );
        await transferFolderLocks(fromPath, nextFolder);
        for (const asset of contained) {
          repairDocumentPath(
            asset.path,
            remapPathAfterFolderMove(asset.path, fromPath, nextFolder),
            asset.header.type,
          );
        }
        setSelectedFolderPath((current) =>
          remapPathAfterFolderMove(current, fromPath, nextFolder),
        );
        await refreshAssetRegistry();
      } else if (nameDialog.kind === "rename") {
        const before = assetRegistry.getByGuid(nameDialog.guid);
        if (!before) return;
        if (refuseTheirsAssetPaths([before.path])) return;
        const renamed = await assetRegistry.renameAsset(
          nameDialog.guid,
          nameDialog.value.trim(),
        );
        await applyLockTransfers(
          [{ from: before.path, to: renamed.path }],
          (path) => sourceControl.lockStateForPath(path),
          (from, to) => sourceControl.transferLock(from, to),
        );
        repairDocumentPath(before.path, renamed.path, renamed.header.type);
        await refreshAssetRegistry();
      }
      setNameDialog(null);
    } finally {
      setBusy(false);
    }
  }, [
    assetRegistry,
    nameDialog,
    allAssets,
    refreshAssetRegistry,
    refuseTheirsAssetPaths,
    repairDocumentPath,
    selectedFolderPath,
    selectedRoot,
    browserRoots,
    sourceControl,
    transferFolderLocks,
  ]);

  const applyRegistryMoves = useCallback(
    async (moves: ContentBrowserDropMove[]) => {
      if (!assetRegistry || moves.length === 0) return;
      const destPath = moves[0]!.destinationPath;
      const dest = contentBrowserFolderOps(destPath, browserRoots);
      if (dest.readOnly) return;
      const destRelative = dest.relative;
      const paths: string[] = [];
      for (const move of moves) {
        if (move.kind === "folder") {
          paths.push(...containedAssetPaths(allAssets, move.sourcePath));
        } else if (move.guid) {
          const path = assetRegistry.getByGuid(move.guid)?.path;
          if (path) paths.push(path);
        }
      }
      if (refuseTheirsAssetPaths(paths)) return;
      for (const move of moves) {
        if (move.kind === "folder") {
          const fromPath = move.sourcePath;
          const from = contentBrowserFolderOps(fromPath, browserRoots);
          if (from.readOnly || from.rootId !== dest.rootId) continue;
          const folderName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
          const nextFolder = `${destPath}/${folderName}`;
          const contained = allAssets.filter(
            (asset) =>
              asset.path === fromPath ||
              asset.path.startsWith(`${fromPath}/`),
          );
          await assetRegistry.moveFolder(
            from.rootId,
            from.relative,
            destRelative,
          );
          await transferFolderLocks(fromPath, nextFolder);
          for (const asset of contained) {
            repairDocumentPath(
              asset.path,
              remapPathAfterFolderMove(asset.path, fromPath, nextFolder),
              asset.header.type,
            );
          }
          setSelectedFolderPath(nextFolder);
        } else if (move.guid) {
          const before = assetRegistry.getByGuid(move.guid);
          if (!before) continue;
          const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
          const relative = destRelative
            ? `${destRelative}/${fileName}`
            : fileName;
          const moved = await assetRegistry.moveAsset(
            move.guid,
            dest.rootId,
            relative,
          );
          await applyLockTransfers(
            [{ from: before.path, to: moved.path }],
            (path) => sourceControl.lockStateForPath(path),
            (from, to) => sourceControl.transferLock(from, to),
          );
          repairDocumentPath(before.path, moved.path, moved.header.type);
          setSelectedFolderPath(destPath);
        }
      }
    },
    [
      allAssets,
      assetRegistry,
      browserRoots,
      refuseTheirsAssetPaths,
      repairDocumentPath,
      sourceControl,
      transferFolderLocks,
    ],
  );

  const confirmMove = useCallback(async () => {
    if (!assetRegistry || !moveTarget) return;
    const dest = contentBrowserFolderOps(moveTarget.folderPath, browserRoots);
    if (dest.readOnly) return;
    setBusy(true);
    try {
      const destPath = moveTarget.folderPath;
      const destRelative = dest.relative;
      if (moveTarget.operation === "copy") {
        for (const fromPath of moveTarget.folderPaths) {
          const from = contentBrowserFolderOps(fromPath, browserRoots);
          if (from.rootId !== dest.rootId) continue;
          await assetRegistry.copyFolder(
            from.rootId,
            from.relative,
            destRelative,
          );
        }
        for (const guid of moveTarget.guids) {
          await assetRegistry.copyAsset(guid, dest.rootId, destRelative);
        }
      } else {
        const moves: ContentBrowserDropMove[] = [
          ...moveTarget.folderPaths.map((path) => ({
            kind: "folder" as const,
            sourcePath: path,
            destinationPath: destPath,
            id: path,
          })),
          ...moveTarget.guids.flatMap((guid) => {
            const before = assetRegistry.getByGuid(guid);
            if (!before) return [];
            return [
              {
                kind: "asset" as const,
                sourcePath: parentFolderPath(before.path),
                destinationPath: destPath,
                id: before.path,
                guid,
              },
            ];
          }),
        ];
        await applyRegistryMoves(moves);
      }
      await refreshAssetRegistry();
      setMoveTarget(null);
    } finally {
      setBusy(false);
    }
  }, [
    applyRegistryMoves,
    assetRegistry,
    moveTarget,
    refreshAssetRegistry,
    browserRoots,
  ]);

  const handleImport = useCallback(async () => {
    if (isMobilePlatform()) {
      try {
        const files = await pickImportFiles({ multiple: true });
        await importPickedFiles(files);
      } catch (err) {
        setImportErrors([
          err instanceof Error ? err.message : String(err),
        ]);
      }
      return;
    }
    importInputRef.current?.click();
  }, [importPickedFiles]);

  const openNewAssetDialog = useCallback(() => {
    if (busy || !selectedRootWritable) return;
    setNewAssetName("");
    setNewAssetOpen(true);
  }, [busy, selectedRootWritable]);

  const emptyGridItems = useMemo(
    () => [
      {
        id: "new-folder",
        label: "New Folder",
        onSelect: () => setNameDialog({ kind: "folder", value: "NewFolder" }),
      },
      {
        id: "new-asset",
        label: "New Asset",
        onSelect: openNewAssetDialog,
      },
      {
        id: "import",
        label: "Import",
        onSelect: () => {
          void handleImport();
        },
      },
    ],
    [handleImport, openNewAssetDialog],
  );
  const {
    menu: emptyGridMenu,
    closeMenu: closeEmptyGridMenu,
    openMenuAt: openEmptyGridMenuAt,
  } = useContextMenu({ items: emptyGridItems });
  const emptyGridBind = useLongPressMenu({
    onMenu: (clientX, clientY) => {
      closeMenu();
      openEmptyGridMenuAt(clientX, clientY);
    },
  });
  const applyTileSelection = useCallback(
    (next: { guids: Set<string>; folderPaths: Set<string> }) => {
      setSelectedGuids(next.guids);
      setSelectedFolderPaths(next.folderPaths);
    },
    [],
  );
  const {
    gridBind: paintBind,
    consumeSelectClick,
    markMenuOpened,
  } = useContentBrowserPaintSelect({
    onPaint: applyTileSelection,
  });

  const openSelectionMenu = useCallback(
    (
      clientX: number,
      clientY: number,
      extra: { guid?: string; folderPath?: string },
    ) => {
      if (extra.folderPath && isFolderTreeRoot(extra.folderPath, rootPrefixes)) {
        return;
      }
      closeEmptyGridMenu();
      let guids = [...selectedGuids];
      let folders = [...selectedFolderPaths].filter(
        (path) => !isFolderTreeRoot(path, rootPrefixes),
      );
      if (extra.guid && !guids.includes(extra.guid)) {
        guids = [...guids, extra.guid];
        setSelectedGuids((current) => addSelectedAssetGuid(current, extra.guid!));
      }
      if (extra.folderPath && !folders.includes(extra.folderPath)) {
        folders = [...folders, extra.folderPath];
        setSelectedFolderPaths((current) =>
          addSelectedFolderPath(current, extra.folderPath!),
        );
      }
      menuTargetGuidsRef.current = guids;
      menuTargetFoldersRef.current = folders;
      const actionIds = new Set(
        contentBrowserContextActions({
          assetCount: guids.length,
          folderCount: folders.length,
        }),
      );
      const items = tileContextItems.filter((item) =>
        actionIds.has(item.id as ContentBrowserContextAction),
      );
      openMenuAt(clientX, clientY, items);
    },
    [
      closeEmptyGridMenu,
      openMenuAt,
      selectedFolderPaths,
      selectedGuids,
      tileContextItems,
    ],
  );

  const openTileMenu = useCallback(
    (guid: string, clientX: number, clientY: number) => {
      openSelectionMenu(clientX, clientY, { guid });
    },
    [openSelectionMenu],
  );

  const openFolderMenu = useCallback(
    (path: string, clientX: number, clientY: number) => {
      openSelectionMenu(clientX, clientY, { folderPath: path });
    },
    [openSelectionMenu],
  );

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
    },
    [
      browserRows,
      selectedFolderPath,
      selectedFolderPaths,
      selectedGuids,
      treeSelectedId,
    ],
  );

  const handleTreeActivate = useCallback(
    (id: string) => {
      const row = browserRows.find((item) => item.id === id);
      if (!row?.guid) return;
      const asset = allAssets.find((item) => item.header.guid === row.guid);
      if (asset) void openOrFocusDocument(asset);
    },
    [allAssets, browserRows, openOrFocusDocument],
  );

  const handleTreeReparent = useCallback(
    (dragId: string, targetId: string | null) => {
      if (!assetRegistry) return;
      const moves = contentBrowserTreeDropMoves({
        dragId,
        targetId,
        rows: browserRows,
        selectedGuids,
        selectedFolderPaths,
        rootPaths: rootPrefixes,
        resolvePath: (guid) => assetRegistry.getByGuid(guid)?.path,
      });
      if (moves.length === 0) return;
      void (async () => {
        setBusy(true);
        try {
          await applyRegistryMoves(moves);
          await refreshAssetRegistry();
        } finally {
          setBusy(false);
        }
      })();
    },
    [
      applyRegistryMoves,
      assetRegistry,
      browserRows,
      refreshAssetRegistry,
      rootPrefixes,
      selectedFolderPaths,
      selectedGuids,
    ],
  );

  const handleImportInputChange = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList?.length) return;
      const files: Array<{ name: string; bytes: Uint8Array }> = [];
      for (const file of Array.from(fileList)) {
        files.push({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
      await importPickedFiles(files);
    },
    [importPickedFiles],
  );

  const handleCreateAsset = useCallback(async () => {
    if (!assetRegistry || newAssetNameTaken || selectedRoot.readOnly) return;
    const name = newAssetName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const type = newAssetType;
      const relative = selectedRoot.relative;
      const fileName = newAssetFileName(type, name);
      if (!fileName) return;
      const result = buildNewAssetResult({
        type,
        name,
        guid: newAssetGuid(),
        parentClass:
          type === "Class"
            ? newAssetParent
            : defaultParentClassForType(type),
        parentOf: classParentOf,
        parentGraphs:
          type === "Class"
            ? collectClassGraphsForPalette({
                assets: allAssets,
                openDocuments,
                classIdForPath: classIdForGraphPath,
              })
            : undefined,
      });
      const created = await assetRegistry.createAsset(
        selectedRoot.rootId,
        relative ? `${relative}/${fileName}` : fileName,
        result,
      );
      setNewAssetOpen(false);
      await refreshAssetRegistry();
      if (type === "Scene") {
        await openOrFocusDocument(created);
      }
    } finally {
      setBusy(false);
    }
  }, [
    allAssets,
    assetRegistry,
    classParentOf,
    newAssetName,
    newAssetNameTaken,
    newAssetParent,
    newAssetType,
    openDocuments,
    openOrFocusDocument,
    refreshAssetRegistry,
    selectedRoot,
  ]);

  if (!projectDocument) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Open a project to browse assets
      </div>
    );
  }

  if (!assetRegistry || folderTrees.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading asset registry…
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card"
      data-testid="content-browser-workspace"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="content-browser-import"
          disabled={busy || !selectedRootWritable}
          onClick={() => void handleImport()}
        >
          <UploadIcon data-icon="inline-start" />
          Import
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="content-browser-new-asset"
          disabled={busy || !selectedRootWritable}
          onClick={openNewAssetDialog}
        >
          <PlusIcon data-icon="inline-start" />
          New Asset
        </Button>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search assets…"
          className="min-h-[var(--chrome-row,28px)] min-w-40"
          data-testid="content-browser-search"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="content-browser-filter"
                aria-label="Filter"
              />
            }
          >
            <ListFilterIcon data-icon="inline-start" />
            Filter
            {typeFilters.length > 0 ? ` (${typeFilters.length})` : ""}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-44"
            data-testid="content-browser-filter-menu"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Asset types</DropdownMenuLabel>
              {typeChips.map((type) => (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={typeFilters.includes(type)}
                  data-testid={`content-browser-filter-${type}`}
                  onCheckedChange={(checked) => {
                    setTypeFilters((current) =>
                      checked === true
                        ? current.includes(type)
                          ? current
                          : [...current, type]
                        : current.filter((entry) => entry !== type),
                    );
                  }}
                >
                  <TypeVisualIcon
                    visual={resolveTypeVisual({ assetType: type })}
                    className="size-4"
                  />
                  {type}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="content-browser-sort"
                aria-label="Sort"
              />
            }
          >
            <ArrowUpDownIcon data-icon="inline-start" />
            Sort
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-44"
            data-testid="content-browser-sort-menu"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sort By</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortMode}
                onValueChange={(value) => {
                  const next = CONTENT_BROWSER_SORT_OPTIONS.find(
                    (option) => option.mode === value,
                  );
                  if (next) setSortMode(next.mode);
                }}
              >
                {CONTENT_BROWSER_SORT_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.mode}
                    value={option.mode}
                    data-testid={`content-browser-sort-${option.mode}`}
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ContentBrowserSelectionActions
          selectionCount={selectionCount}
          busy={busy}
          onDeselectAll={() => {
            setSelectedGuids(new Set());
            setSelectedFolderPaths(new Set());
          }}
          onRequestDelete={() => requestDeleteSelection()}
        />
        <input
          ref={importInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="content-browser-import-input"
          onChange={(event) => {
            void handleImportInputChange(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="flex w-56 min-h-0 shrink-0 flex-col gap-1 overflow-hidden border-r border-border p-2"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-start"
            data-testid="content-browser-new-folder"
            disabled={busy || !selectedRootWritable}
            onClick={() =>
              setNameDialog({ kind: "folder", value: "NewFolder" })
            }
          >
            <FolderPlusIcon data-icon="inline-start" />
            New Folder
          </Button>
          <div className="min-h-0 flex-1">
            <TreeView
              nodes={treeNodes}
              selectedId={treeSelectedId}
              selectedIds={treeSelectedIds}
              onSelect={handleTreeSelect}
              onToggleExpanded={(id) => {
                const row = browserRows.find((item) => item.id === id);
                if (!row || row.kind !== "folder" || !row.hasChildren) return;
                setCollapsedFolders((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              onReparent={handleTreeReparent}
              onActivate={handleTreeActivate}
              emptyLabel="No folders"
              data-testid="content-browser-folder-tree"
            />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={scrollerRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
            data-testid="content-browser-asset-grid"
            style={paintBind.style}
            onClick={() => {
              if (consumeSelectClick()) return;
              setSelectedGuids(new Set());
              setSelectedFolderPaths(new Set());
            }}
            onDoubleClick={(event) => {
              if (
                !isContentBrowserEmptyGridDoubleClickTarget(event.target)
              ) {
                return;
              }
              openNewAssetDialog();
            }}
            onContextMenu={emptyGridBind.onContextMenu}
            onPointerDown={emptyGridBind.onPointerDown}
            onPointerMove={emptyGridBind.onPointerMove}
            onPointerUp={emptyGridBind.onPointerUp}
            onPointerCancel={emptyGridBind.onPointerCancel}
            onPointerDownCapture={paintBind.onPointerDownCapture}
            onPointerMoveCapture={paintBind.onPointerMoveCapture}
            onPointerUpCapture={paintBind.onPointerUpCapture}
            onPointerCancelCapture={paintBind.onPointerCancelCapture}
          >
            {gridItems.length === 0 ? (
              <p
                className="p-3 text-sm text-muted-foreground"
                data-testid="content-browser-empty-copy"
              >
                No assets in this folder match the current filters.
              </p>
            ) : (
              <div className="relative" style={{ height: spacerHeight }}>
                {gridItems
                  .slice(slice.firstIndex, slice.lastIndex)
                  .map((item, offset) => {
                    const index = slice.firstIndex + offset;
                    const style = contentBrowserTileStyle(
                      index,
                      slice.columnCount,
                    );
                    if (item.kind === "folder") {
                      return (
                        <div key={item.path} style={style}>
                          <ContentBrowserFolderTile
                            path={item.path}
                            name={item.name}
                            selected={selectedFolderPaths.has(item.path)}
                            consumeSelectClick={consumeSelectClick}
                            onSelect={() =>
                              applyTileSelection(
                                exclusiveSelectFolder(item.path),
                              )
                            }
                            onOpen={() => {
                              setSelectedFolderPath(item.path);
                              setSelectedGuids(new Set());
                              setSelectedFolderPaths(new Set());
                            }}
                            onLongPressMenu={(x, y) => {
                              markMenuOpened();
                              openFolderMenu(item.path, x, y);
                            }}
                          />
                        </div>
                      );
                    }
                    const asset = item.asset;
                    return (
                      <div key={asset.header.guid} style={style}>
                        <ContentBrowserAssetTile
                          asset={asset}
                          selected={selectedGuids.has(asset.header.guid)}
                          thumbnailUrl={
                            thumbnailUrls[asset.header.guid] ?? null
                          }
                          typeVisual={visualForIndexedAsset(
                            asset,
                            classParentOf,
                          )}
                          hasCompileError={
                            compileErrorGuids.has(asset.header.guid) ||
                            compileErrorGuids.has(asset.path)
                          }
                          onSelect={() =>
                            applyTileSelection(
                              exclusiveSelectAsset(asset.header.guid),
                            )
                          }
                          consumeSelectClick={consumeSelectClick}
                          onOpen={() => void openOrFocusDocument(asset)}
                          sourceControlEnabled={sourceControl.enabled}
                          lockState={sourceControl.lockStateForPath(
                            asset.path,
                          )}
                          lockOwnerName={
                            sourceControl.lockForPath(asset.path)?.ownerName
                          }
                          onLongPressMenu={(x, y) => {
                            markMenuOpened();
                            openTileMenu(asset.header.guid, x, y);
                          }}
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>

      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <ContextMenuOverlay menu={emptyGridMenu} onClose={closeEmptyGridMenu} />

      <ContentBrowserNewAssetDialog
        open={newAssetOpen}
        onOpenChange={(open) => {
          setNewAssetOpen(open);
          if (open) setNewAssetName("");
        }}
        type={newAssetType}
        onTypeChange={setNewAssetType}
        name={newAssetName}
        onNameChange={setNewAssetName}
        parentClass={newAssetParent}
        onParentClassChange={setNewAssetParent}
        classAssets={allAssets.filter((asset) => asset.header.type === "Class")}
        nameTaken={newAssetNameTaken}
        busy={busy}
        onCreate={() => {
          void handleCreateAsset();
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent
          variant="destructive"
          data-testid="content-browser-delete-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogMedia data-testid="content-browser-delete-media">
              <OctagonAlertIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {deleteTarget?.kind === "folder"
                ? "Delete folder?"
                : deleteTarget?.kind === "selection"
                  ? "Delete items?"
                  : "Delete assets?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "folder"
                ? `Folder ${deleteTarget.path} and its assets will be removed permanently. This action is not undoable.`
                : deleteTarget?.kind === "selection"
                  ? "The selected folders and assets will be removed permanently. This action is not undoable."
                  : "The following assets will be removed permanently. This action is not undoable."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <ul
              className="list-disc pl-5"
              data-testid="content-browser-delete-list"
            >
              {deleteListNames.map((name) => (
                <li key={name}>
                  <SelectableText>{name}</SelectableText>
                </li>
              ))}
            </ul>
            {deleteLastSceneClassLines.map((line) => (
              <p
                key={line}
                className="font-medium text-foreground"
                data-testid="content-browser-delete-last-warning"
              >
                {line}
              </p>
            ))}
            {deleteInboundRefs.length > 0 ? (
              <>
                <p>Inbound references from other assets:</p>
                <ul className="list-disc pl-5">
                  {deleteInboundRefs.map((ref) => (
                    <li key={ref.guid}>
                      <SelectableText>{ref.name}</SelectableText>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>No inbound references.</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={busy}
              size="touch"
              className="h-[var(--touch-target,44px)]"
              data-testid="content-browser-delete-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="touch"
              className="h-[var(--touch-target,44px)]"
              disabled={busy}
              data-testid="content-browser-delete-confirm"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
      >
        <AlertDialogContent data-testid="content-browser-name-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {nameDialog?.kind === "folder"
                ? "New Folder"
                : nameDialog?.kind === "rename-folder"
                  ? "Rename Folder"
                  : "Rename Asset"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nameDialog?.kind === "folder"
                ? "Create a folder under the current selection."
                : nameDialog?.kind === "rename-folder"
                  ? "Rename the folder. Nested assets keep their guids."
                  : "Rename the asset file. References by guid stay intact."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            className="min-h-[var(--touch-target,44px)]"
            data-testid="content-browser-name-input"
            aria-invalid={nameDialogTaken || undefined}
            value={nameDialog?.value ?? ""}
            onChange={(event) =>
              setNameDialog((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
          />
          {nameDialogTaken ? (
            <p
              className="text-sm text-destructive"
              data-testid="content-browser-name-taken"
            >
              That name is already used in this folder.
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || nameDialogTaken || !nameDialog?.value.trim()}
              data-testid="content-browser-name-confirm"
              onClick={(event) => {
                event.preventDefault();
                void confirmNameDialog();
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ContentBrowserMoveDialog
        key={
          moveTarget
            ? `${moveTarget.operation}:${moveTarget.guids.join(",")}:${moveTarget.folderPaths.join(",")}`
            : "closed"
        }
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null);
        }}
        kind={moveTarget?.kind ?? "asset"}
        operation={moveTarget?.operation ?? "move"}
        name={moveTarget?.name ?? ""}
        currentFolderPath={
          moveTarget
            ? moveTarget.kind === "folder"
              ? parentFolderPath(
                  moveTarget.sourcePath,
                  contentBrowserFolderOps(moveTarget.sourcePath, browserRoots)
                    .pathPrefix,
                )
              : moveTarget.assetSourcePaths[0] ?? moveTarget.sourcePath
            : ASSETS_ROOT
        }
        sourcePath={moveTarget?.sourcePath ?? ASSETS_ROOT}
        folderTree={
          folderTrees.find((tree) => {
            const source = moveTarget?.sourcePath ?? ASSETS_ROOT;
            const prefix = contentBrowserFolderOps(source, browserRoots)
              .pathPrefix;
            return tree.path === prefix;
          }) ?? folderTrees[0]!
        }
        destinationPath={moveTarget?.folderPath ?? ASSETS_ROOT}
        onDestinationChange={(path) =>
          setMoveTarget((current) =>
            current ? { ...current, folderPath: path } : current,
          )
        }
        onConfirm={() => void confirmMove()}
        busy={busy}
        typeVisual={moveTarget?.typeVisual ?? null}
        itemCount={moveTarget?.itemCount}
        assetSourcePaths={moveTarget?.assetSourcePaths}
        folderSourcePaths={moveTarget?.folderSourcePaths}
      />

      <AlertDialog
        open={refsSummary !== null}
        onOpenChange={(open) => {
          if (!open) setRefsSummary(null);
        }}
      >
        <AlertDialogContent data-testid="content-browser-refs-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>References</AlertDialogTitle>
            <AlertDialogDescription>
              Dependencies for {refsSummary?.name}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 text-sm">
            <p>
              <span className="font-medium">Inbound:</span>{" "}
              <SelectableText>{refsSummary?.inbound}</SelectableText>
            </p>
            <p>
              <span className="font-medium">Outbound:</span>{" "}
              <SelectableText>{refsSummary?.outbound}</SelectableText>
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setRefsSummary(null)}>
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={importProgress !== null}>
        <DialogContent
          showCloseButton={false}
          data-testid="importing-overlay"
        >
          <DialogHeader>
            <DialogTitle>Importing</DialogTitle>
            <DialogDescription>
              Writing assets into the project. Texture compression continues in
              the background after this finishes.
            </DialogDescription>
          </DialogHeader>
          {importProgress ? (
            <div className="flex flex-col gap-2">
              <p data-testid="importing-file" className="truncate text-sm">
                {importProgress.currentName}
              </p>
              <p
                data-testid="importing-count"
                className="text-sm text-muted-foreground tabular-nums"
              >
                {importProgress.done} / {importProgress.total}
              </p>
              <Progress
                value={Math.round(
                  (100 * importProgress.done) /
                    Math.max(importProgress.total, 1),
                )}
                data-testid="importing-progress"
              >
                <ProgressLabel>Importing</ProgressLabel>
                <ProgressValue />
              </Progress>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={importErrors !== null}
        onOpenChange={(open) => {
          if (!open) setImportErrors(null);
        }}
      >
        <AlertDialogContent data-testid="import-errors-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Import failed</AlertDialogTitle>
            <AlertDialogDescription>
              Some files could not be imported.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {importErrors?.map((message) => (
              <li key={message}>
                <SelectableText>{message}</SelectableText>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogAction
              data-testid="import-errors-dismiss"
              onClick={() => setImportErrors(null)}
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={openError !== null}
        onOpenChange={(open) => {
          if (!open) setOpenError(null);
        }}
      >
        <AlertDialogContent data-testid="content-browser-open-error">
          <AlertDialogHeader>
            <AlertDialogTitle>Could Not Open Asset</AlertDialogTitle>
            <AlertDialogDescription>
              {openError ?? "The asset could not be opened."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              data-testid="content-browser-open-error-dismiss"
              onClick={() => setOpenError(null)}
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
