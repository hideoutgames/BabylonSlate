import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
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
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@babylonslate/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
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
  refuseTheirsPaths,
} from "../lib/source-control-file-ops";
import { useProjectSearch } from "../context/project-search-context";
import { useValidation } from "../context/validation-context";
import {
  ASSETS_ROOT,
  CREATABLE_ASSET_TYPES,
  ENGINE_BASE_CLASSES,
  addSelectedAssetGuid,
  addSelectedFolderPath,
  buildNewAssetResult,
  classParentLookup,
  collectFolderGuidsFromTrees,
  contentBrowserContextActions,
  contentBrowserMoveFromDrop,
  contentBrowserMovePreviewName,
  defaultParentClassForType,
  displayAssetTitle,
  filterAssets,
  flattenContentBrowserForest,
  flattenFolderForest,
  guidsOutsideSelectedFolders,
  isFolderNameTaken,
  isFolderTreeRoot,
  isNewAssetNameTaken,
  isRenameNameTaken,
  joinAssetFolderPath,
  listChildFoldersFromTrees,
  newAssetFileName,
  parentFolderPath,
  remapPathAfterFolderMove,
  rootSelectedFolderPaths,
  uniqueAssetTypes,
  visualForIndexedAsset,
  type ContentBrowserContextAction,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import {
  canMutateContentBrowserRoot,
  contentBrowserFolderOps,
  contentBrowserRoots,
  filterBabpluginFiles,
  pluginContentToggleLabel,
  PROJECT_CONTENT_ROOT_ID,
} from "../lib/plugin-ui";
import { revealAssetFromTarget } from "../lib/search-navigation";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { ContentBrowserAssetTile } from "./content-browser-asset-tile";
import { ContentBrowserFolderTile } from "./content-browser-folder-tile";
import { ContentBrowserMoveDialog } from "./content-browser-move-dialog";
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

export function ContentBrowserWorkspace() {
  const {
    projectDocument,
    assetRegistry,
    registryVersion,
    refreshAssetRegistry,
    repathDocument,
    openDocument,
    setActiveDocument,
    tabOrder,
    loadAssetThumbnail,
    thumbnailsEnabled,
    pluginDescriptors,
    showPluginContent,
    setShowPluginContent,
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
  const selectedRoot = useMemo(
    () => contentBrowserFolderOps(selectedFolderPath, browserRoots),
    [browserRoots, selectedFolderPath],
  );
  const selectedRootWritable = canMutateContentBrowserRoot(
    browserRoots.find((root) => root.id === selectedRoot.rootId),
  );

  useEffect(() => {
    if (!showPluginContent && selectedRoot.rootId !== PROJECT_ROOT_ID) {
      setSelectedFolderPath(ASSETS_ROOT);
    }
  }, [selectedRoot.rootId, showPluginContent]);

  const folderTrees = useMemo(() => {
    if (!assetRegistry) return [];
    return browserRoots.map((root) => {
      const tree = assetRegistry.folderTree(root.id);
      return {
        ...tree,
        name:
          root.id === PROJECT_ROOT_ID
            ? tree.name
            : root.readOnly
              ? `${root.label} (Read Only)`
              : root.label,
      };
    });
  }, [assetRegistry, browserRoots, registryVersion]);

  const allAssets = useMemo(() => {
    if (!assetRegistry) return [];
    return browserRoots.flatMap((root) =>
      assetRegistry.list({ rootId: root.id }),
    );
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
      filterAssets(allAssets, {
        folderGuids,
        typeFilters,
        search,
      }),
    [allAssets, folderGuids, search, typeFilters],
  );

  const childFolders = useMemo(() => {
    if (folderTrees.length === 0) return [];
    const folders = listChildFoldersFromTrees(folderTrees, selectedFolderPath);
    const needle = search.trim().toLowerCase();
    if (!needle) return folders;
    return folders.filter((folder) =>
      folder.name.toLowerCase().includes(needle),
    );
  }, [folderTrees, search, selectedFolderPath]);

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
    const objectUrls: string[] = [];
    void (async () => {
      const next: Record<string, string> = { ...thumbnailUrlsRef.current };
      for (const asset of visibleAssets) {
        if (asset.header.type !== "Texture") continue;
        if (next[asset.header.guid]) continue;
        const bytes = await loadAssetThumbnail(asset.header.guid);
        if (cancelled || !bytes) continue;
        const url = URL.createObjectURL(
          new Blob([bytes], { type: "image/jpeg" }),
        );
        objectUrls.push(url);
        next[asset.header.guid] = url;
      }
      if (!cancelled) setThumbnailUrls(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAssetThumbnail, thumbnailsEnabled, visibleAssets]);

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
        guids: [...folderGuidsSet, ...extraGuids],
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

  const confirmMove = useCallback(async () => {
    if (!assetRegistry || !moveTarget) return;
    const dest = contentBrowserFolderOps(moveTarget.folderPath, browserRoots);
    if (dest.readOnly) return;
    if (moveTarget.operation !== "copy") {
      const paths: string[] = [];
      for (const fromPath of moveTarget.folderPaths) {
        paths.push(...containedAssetPaths(allAssets, fromPath));
      }
      for (const guid of moveTarget.guids) {
        const path = assetRegistry.getByGuid(guid)?.path;
        if (path) paths.push(path);
      }
      if (refuseTheirsAssetPaths(paths)) return;
    }
    setBusy(true);
    try {
      const destPath = moveTarget.folderPath;
      const destRelative = dest.relative;
      for (const fromPath of moveTarget.folderPaths) {
        const from = contentBrowserFolderOps(fromPath, browserRoots);
        if (from.rootId !== dest.rootId) continue;
        if (moveTarget.operation === "copy") {
          await assetRegistry.copyFolder(
            from.rootId,
            from.relative,
            destRelative,
          );
        } else {
          const folderName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
          const nextFolder = `${destPath}/${folderName}`;
          const contained = allAssets.filter(
            (asset) =>
              asset.path === fromPath || asset.path.startsWith(`${fromPath}/`),
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
        }
      }
      for (const guid of moveTarget.guids) {
        const before = assetRegistry.getByGuid(guid);
        if (!before) continue;
        if (moveTarget.operation === "copy") {
          await assetRegistry.copyAsset(guid, dest.rootId, destRelative);
        } else {
          const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
          const relative = destRelative
            ? `${destRelative}/${fileName}`
            : fileName;
          const moved = await assetRegistry.moveAsset(
            guid,
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
      await refreshAssetRegistry();
      setMoveTarget(null);
    } finally {
      setBusy(false);
    }
  }, [
    allAssets,
    assetRegistry,
    moveTarget,
    refreshAssetRegistry,
    refuseTheirsAssetPaths,
    repairDocumentPath,
    browserRoots,
    sourceControl,
    transferFolderLocks,
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
        onSelect: () => {
          setNewAssetName("");
          setNewAssetOpen(true);
        },
      },
      {
        id: "import",
        label: "Import",
        onSelect: () => {
          void handleImport();
        },
      },
    ],
    [handleImport],
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

  const handleTreeSelect = useCallback((id: string) => {
    const row = browserRows.find((item) => item.id === id);
    if (!row) return;
    if (row.kind === "folder") {
      setSelectedFolderPath(row.path);
      setSelectedGuids(new Set());
      setSelectedFolderPaths(new Set());
      return;
    }
    if (row.guid) {
      setSelectedFolderPath(parentFolderPath(row.path));
      setSelectedGuids(new Set([row.guid]));
      setSelectedFolderPaths(new Set());
    }
  }, [browserRows]);

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
      const move = contentBrowserMoveFromDrop(
        dragId,
        targetId,
        browserRows,
        rootPrefixes,
      );
      if (!move || !assetRegistry) return;
      void (async () => {
        setBusy(true);
        try {
          if (move.kind === "folder") {
            const fromPath = move.sourcePath;
            const destPath = move.destinationPath;
            const from = contentBrowserFolderOps(fromPath, browserRoots);
            const dest = contentBrowserFolderOps(destPath, browserRoots);
            if (from.readOnly || dest.readOnly || from.rootId !== dest.rootId) {
              return;
            }
            const folderName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
            const nextFolder = `${destPath}/${folderName}`;
            const contained = allAssets.filter(
              (asset) =>
                asset.path === fromPath ||
                asset.path.startsWith(`${fromPath}/`),
            );
            if (refuseTheirsAssetPaths(contained.map((asset) => asset.path))) {
              return;
            }
            await assetRegistry.moveFolder(
              from.rootId,
              from.relative,
              dest.relative,
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
            if (!before) return;
            if (refuseTheirsAssetPaths([before.path])) return;
            const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
            const dest = contentBrowserFolderOps(
              move.destinationPath,
              browserRoots,
            );
            if (dest.readOnly) return;
            const relative = dest.relative
              ? `${dest.relative}/${fileName}`
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
            setSelectedFolderPath(move.destinationPath);
          }
          await refreshAssetRegistry();
        } finally {
          setBusy(false);
        }
      })();
    },
    [
      allAssets,
      assetRegistry,
      browserRows,
      browserRoots,
      rootPrefixes,
      refreshAssetRegistry,
      refuseTheirsAssetPaths,
      repairDocumentPath,
      sourceControl,
      transferFolderLocks,
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
    assetRegistry,
    newAssetName,
    newAssetNameTaken,
    newAssetParent,
    newAssetType,
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
          onClick={() => {
            setNewAssetName("");
            setNewAssetOpen(true);
          }}
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
          <Button
            type="button"
            variant="outline"
            className="mt-1 w-full min-h-[var(--touch-target,44px)] justify-center"
            data-testid="content-browser-show-plugin-content"
            aria-label={pluginContentToggleLabel(showPluginContent)}
            onClick={() => setShowPluginContent(!showPluginContent)}
          >
            {pluginContentToggleLabel(showPluginContent)}
          </Button>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
            data-testid="content-browser-asset-grid"
            onClick={() => {
              setSelectedGuids(new Set());
              setSelectedFolderPaths(new Set());
            }}
            onContextMenu={emptyGridBind.onContextMenu}
            onPointerDown={emptyGridBind.onPointerDown}
            onPointerMove={emptyGridBind.onPointerMove}
            onPointerUp={emptyGridBind.onPointerUp}
            onPointerCancel={emptyGridBind.onPointerCancel}
          >
            <div className="grid grid-cols-[repeat(auto-fill,9rem)] content-start gap-2 p-3">
              {childFolders.map((folder) => (
                <ContentBrowserFolderTile
                  key={folder.path}
                  path={folder.path}
                  name={folder.name}
                  selected={selectedFolderPaths.has(folder.path)}
                  onSelect={() =>
                    setSelectedFolderPaths((current) =>
                      addSelectedFolderPath(current, folder.path),
                    )
                  }
                  onOpen={() => {
                    setSelectedFolderPath(folder.path);
                    setSelectedGuids(new Set());
                    setSelectedFolderPaths(new Set());
                  }}
                  onLongPressMenu={(x, y) => openFolderMenu(folder.path, x, y)}
                />
              ))}
              {visibleAssets.map((asset) => (
                <ContentBrowserAssetTile
                  key={asset.header.guid}
                  asset={asset}
                  selected={selectedGuids.has(asset.header.guid)}
                  thumbnailUrl={thumbnailUrls[asset.header.guid] ?? null}
                  typeVisual={visualForIndexedAsset(asset, classParentOf)}
                  hasCompileError={
                    compileErrorGuids.has(asset.header.guid) ||
                    compileErrorGuids.has(asset.path)
                  }
                  onSelect={() =>
                    setSelectedGuids((current) =>
                      addSelectedAssetGuid(current, asset.header.guid),
                    )
                  }
                  onOpen={() => void openOrFocusDocument(asset)}
                  sourceControlEnabled={sourceControl.enabled}
                  lockState={sourceControl.lockStateForPath(asset.path)}
                  lockOwnerName={
                    sourceControl.lockForPath(asset.path)?.ownerName
                  }
                  onLongPressMenu={(x, y) =>
                    openTileMenu(asset.header.guid, x, y)
                  }
                />
              ))}
              {visibleAssets.length === 0 && childFolders.length === 0 ? (
                <p className="col-span-full text-sm text-muted-foreground">
                  No assets in this folder match the current filters.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <ContextMenuOverlay menu={emptyGridMenu} onClose={closeEmptyGridMenu} />

      <AlertDialog
        open={newAssetOpen}
        onOpenChange={(open) => {
          setNewAssetOpen(open);
          if (open) setNewAssetName("");
        }}
      >
        <AlertDialogContent data-testid="content-browser-new-asset-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>New Asset</AlertDialogTitle>
            <AlertDialogDescription>
              Create a new asset in the selected folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FieldGroup className="py-2">
            <Field>
              <FieldLabel htmlFor="new-asset-type">Type</FieldLabel>
              <Select
                value={newAssetType}
                onValueChange={(value) =>
                  setNewAssetType(value as CreatableAssetType)
                }
              >
                <SelectTrigger
                  id="new-asset-type"
                  data-testid="new-asset-type"
                  className="min-h-[var(--touch-target,44px)] w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATABLE_ASSET_TYPES.map((type) => (
                    <SelectItem
                      key={type}
                      value={type}
                      data-testid={`new-asset-type-${type}`}
                    >
                      <span className="flex items-center gap-2">
                        <TypeVisualIcon
                          visual={resolveTypeVisual({ assetType: type })}
                          className="size-4"
                        />
                        {type}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field data-invalid={newAssetNameTaken || undefined}>
              <FieldLabel htmlFor="new-asset-name">Name</FieldLabel>
              <Input
                id="new-asset-name"
                data-testid="new-asset-name"
                className="min-h-[var(--touch-target,44px)]"
                value={newAssetName}
                aria-invalid={newAssetNameTaken || undefined}
                onChange={(event) => setNewAssetName(event.target.value)}
              />
              {newAssetNameTaken ? (
                <FieldError data-testid="new-asset-name-taken">
                  An asset with this name already exists in the folder.
                </FieldError>
              ) : null}
            </Field>
            {newAssetType === "Class" ? (
              <Field>
                <FieldLabel htmlFor="new-asset-parent">Parent class</FieldLabel>
                <Select value={newAssetParent} onValueChange={setNewAssetParent}>
                  <SelectTrigger
                    id="new-asset-parent"
                    data-testid="new-asset-parent"
                    className="min-h-[var(--touch-target,44px)] w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENGINE_BASE_CLASSES.map((base) => (
                      <SelectItem
                        key={base}
                        value={base}
                        data-testid={`new-asset-parent-${base}`}
                      >
                        <span className="flex items-center gap-2">
                          <TypeVisualIcon
                            visual={resolveTypeVisual({
                              classId: base,
                              family: "class",
                            })}
                            className="size-4"
                          />
                          {base}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </FieldGroup>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || newAssetNameTaken || !newAssetName.trim()}
              data-testid="content-browser-new-asset-create"
              onClick={(event) => {
                event.preventDefault();
                void handleCreateAsset();
              }}
            >
              Create
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            <ul className="list-disc pl-5">
              {deleteTarget?.guids.map((guid) => (
                <li key={guid}>
                  <SelectableText>{resolveAssetName(guid)}</SelectableText>
                </li>
              ))}
            </ul>
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
