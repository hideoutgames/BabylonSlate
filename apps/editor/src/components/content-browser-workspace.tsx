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
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import type { IndexedAsset } from "@babylonslate/assets";
import { newAssetGuid } from "@babylonslate/assets";
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
import { documentId, documentKindForAssetType, labelFromPath } from "@babylonslate/core";
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
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { useDocuments } from "../context/document-context";
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
  collectFolderGuids,
  contentBrowserContextActions,
  contentBrowserMoveFromDrop,
  contentBrowserMovePreviewName,
  defaultParentClassForType,
  displayAssetTitle,
  filterAssets,
  flattenContentBrowserTree,
  flattenFolderTree,
  folderRelativePath,
  guidsOutsideSelectedFolders,
  isFolderNameTaken,
  isNewAssetNameTaken,
  isRenameNameTaken,
  joinAssetFolderPath,
  listChildFolders,
  newAssetFileName,
  parentFolderPath,
  remapPathAfterFolderMove,
  rootSelectedFolderPaths,
  uniqueAssetTypes,
  visualForIndexedAsset,
  type ContentBrowserContextAction,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import { revealAssetFromTarget } from "../lib/search-navigation";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { ContentBrowserAssetTile } from "./content-browser-asset-tile";
import { ContentBrowserFolderTile } from "./content-browser-folder-tile";
import { ContentBrowserMoveDialog } from "./content-browser-move-dialog";

const PROJECT_ROOT_ID = "project";

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

  const folderTree = useMemo(
    () => assetRegistry?.folderTree(PROJECT_ROOT_ID) ?? null,
    [assetRegistry],
  );

  const allAssets = useMemo(
    () => assetRegistry?.list({ rootId: PROJECT_ROOT_ID }) ?? [],
    [assetRegistry, registryVersion],
  );
  const classParentOf = useMemo(
    () => classParentLookup(allAssets),
    [allAssets],
  );

  const folderGuids = useMemo(() => {
    if (!folderTree) return null;
    return collectFolderGuids(selectedFolderPath, folderTree);
  }, [folderTree, selectedFolderPath]);

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
    if (!folderTree) return [];
    const folders = listChildFolders(folderTree, selectedFolderPath);
    const needle = search.trim().toLowerCase();
    if (!needle) return folders;
    return folders.filter((folder) =>
      folder.name.toLowerCase().includes(needle),
    );
  }, [folderTree, search, selectedFolderPath]);

  const browserRows = useMemo(() => {
    if (!folderTree) return [];
    return flattenContentBrowserTree(folderTree, allAssets, collapsedFolders);
  }, [allAssets, collapsedFolders, folderTree]);

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
      folderTree ? flattenFolderTree(folderTree).map((row) => row.path) : [],
    [folderTree],
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
      if (!folderTree || path === ASSETS_ROOT) return;
      const guids = [...collectFolderGuids(path, folderTree, { recursive: true })];
      setDeleteTarget({ kind: "folder", path, guids });
    },
    [folderTree],
  );

  const requestDeleteSnapshot = useCallback(
    (guids: string[], folderPaths: string[]) => {
      const folders = folderPaths.filter((path) => path !== ASSETS_ROOT);
      if (!folderTree) {
        requestDelete(guids);
        return;
      }
      if (folders.length === 0) {
        requestDelete(guids);
        return;
      }
      const folderGuidsSet = new Set<string>();
      for (const path of folders) {
        for (const guid of collectFolderGuids(path, folderTree, {
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
    [folderTree, requestDelete, requestDeleteFolder],
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
        menuTargetFoldersRef.current.filter((path) => path !== ASSETS_ROOT),
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
              menuTargetFoldersRef.current.filter((path) => path !== ASSETS_ROOT),
            );
            const guids = guidsOutsideSelectedFolders(
              menuTargetGuidsRef.current,
              folders,
              (guid) => assetRegistry.getByGuid(guid)?.path,
            );
            const browseFolder = folderRelativePath(
              selectedFolderPath,
              ASSETS_ROOT,
            );
            for (const path of folders) {
              await assetRegistry.duplicateFolder(
                PROJECT_ROOT_ID,
                folderRelativePath(path, ASSETS_ROOT),
              );
            }
            for (const guid of guids) {
              await assetRegistry.duplicateAsset(
                guid,
                PROJECT_ROOT_ID,
                browseFolder,
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
            (path) => path !== ASSETS_ROOT,
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
    setBusy(true);
    try {
      const folders =
        deleteTarget.kind === "folder"
          ? [deleteTarget.path]
          : deleteTarget.kind === "selection"
            ? deleteTarget.folders
            : [];
      for (const path of folders) {
        const relative = folderRelativePath(path, ASSETS_ROOT);
        await assetRegistry.deleteFolder(PROJECT_ROOT_ID, relative);
        setSelectedFolderPath((current) =>
          current === path || current.startsWith(`${path}/`)
            ? parentFolderPath(path)
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
  }, [assetRegistry, deleteTarget, refreshAssetRegistry]);

  const importPickedFiles = useCallback(
    async (files: Array<{ name: string; bytes: Uint8Array }>) => {
      if (!assetRegistry || !files.length) return;
      const errors: string[] = [];
      setBusy(true);
      setImportProgress({
        total: files.length,
        done: 0,
        currentName: files[0]!.name,
      });
      try {
        const folder = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!;
          setImportProgress({
            total: files.length,
            done: index,
            currentName: file.name,
          });
          try {
            await assetRegistry.importFile(
              PROJECT_ROOT_ID,
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
            total: files.length,
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
    [assetRegistry, refreshAssetRegistry, selectedFolderPath],
  );

  const confirmNameDialog = useCallback(async () => {
    if (!assetRegistry || !nameDialog) return;
    setBusy(true);
    try {
      if (nameDialog.kind === "folder") {
        const parent = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
        const relative = parent
          ? `${parent}/${nameDialog.value.trim()}`
          : nameDialog.value.trim();
        if (!relative) return;
        await assetRegistry.createFolder(PROJECT_ROOT_ID, relative);
        await refreshAssetRegistry();
        setSelectedFolderPath(`${ASSETS_ROOT}/${relative}`);
      } else if (nameDialog.kind === "rename-folder") {
        const fromPath = nameDialog.path;
        const destPath = parentFolderPath(fromPath);
        const newName = nameDialog.value.trim();
        if (!newName) return;
        const nextFolder = `${destPath}/${newName}`;
        const contained = allAssets.filter(
          (asset) =>
            asset.path === fromPath || asset.path.startsWith(`${fromPath}/`),
        );
        await assetRegistry.moveFolder(
          PROJECT_ROOT_ID,
          folderRelativePath(fromPath, ASSETS_ROOT),
          folderRelativePath(destPath, ASSETS_ROOT),
          newName,
        );
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
        const renamed = await assetRegistry.renameAsset(
          nameDialog.guid,
          nameDialog.value.trim(),
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
    repairDocumentPath,
    selectedFolderPath,
  ]);

  const confirmMove = useCallback(async () => {
    if (!assetRegistry || !moveTarget) return;
    setBusy(true);
    try {
      const destPath = moveTarget.folderPath;
      const destRelative = folderRelativePath(destPath, ASSETS_ROOT);
      for (const fromPath of moveTarget.folderPaths) {
        if (moveTarget.operation === "copy") {
          await assetRegistry.copyFolder(
            PROJECT_ROOT_ID,
            folderRelativePath(fromPath, ASSETS_ROOT),
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
            PROJECT_ROOT_ID,
            folderRelativePath(fromPath, ASSETS_ROOT),
            destRelative,
          );
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
          await assetRegistry.copyAsset(guid, PROJECT_ROOT_ID, destRelative);
        } else {
          const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
          const relative = destRelative
            ? `${destRelative}/${fileName}`
            : fileName;
          const moved = await assetRegistry.moveAsset(
            guid,
            PROJECT_ROOT_ID,
            relative,
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
    repairDocumentPath,
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
      if (extra.folderPath === ASSETS_ROOT) return;
      closeEmptyGridMenu();
      let guids = [...selectedGuids];
      let folders = [...selectedFolderPaths].filter(
        (path) => path !== ASSETS_ROOT,
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
      const move = contentBrowserMoveFromDrop(dragId, targetId, browserRows);
      if (!move || !assetRegistry) return;
      void (async () => {
        setBusy(true);
        try {
          if (move.kind === "folder") {
            const fromPath = move.sourcePath;
            const destPath = move.destinationPath;
            const folderName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
            const nextFolder = `${destPath}/${folderName}`;
            const contained = allAssets.filter(
              (asset) =>
                asset.path === fromPath ||
                asset.path.startsWith(`${fromPath}/`),
            );
            await assetRegistry.moveFolder(
              PROJECT_ROOT_ID,
              folderRelativePath(fromPath, ASSETS_ROOT),
              folderRelativePath(destPath, ASSETS_ROOT),
            );
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
            const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
            const folder = folderRelativePath(move.destinationPath, ASSETS_ROOT);
            const relative = folder ? `${folder}/${fileName}` : fileName;
            const moved = await assetRegistry.moveAsset(
              move.guid,
              PROJECT_ROOT_ID,
              relative,
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
      refreshAssetRegistry,
      repairDocumentPath,
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
    if (!assetRegistry || newAssetNameTaken) return;
    const name = newAssetName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const type = newAssetType;
      const relative = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
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
        PROJECT_ROOT_ID,
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
    selectedFolderPath,
  ]);

  if (!projectDocument) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Open a project to browse assets
      </div>
    );
  }

  if (!assetRegistry || !folderTree) {
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
          disabled={busy}
          onClick={() => void handleImport()}
        >
          <UploadIcon data-icon="inline-start" />
          Import
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="content-browser-new-asset"
          disabled={busy}
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
        {selectionCount > 0 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="content-browser-deselect-all"
              disabled={busy}
              onClick={() => {
                setSelectedGuids(new Set());
                setSelectedFolderPaths(new Set());
              }}
            >
              <XIcon data-icon="inline-start" />
              Deselect All
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="content-browser-delete-selected"
              disabled={busy}
              onClick={() => requestDeleteSelection()}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete ({selectionCount})
            </Button>
          </>
        ) : null}
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
            disabled={busy}
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
        <AlertDialogContent data-testid="content-browser-delete-dialog">
          <AlertDialogHeader>
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
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
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
              ? parentFolderPath(moveTarget.sourcePath)
              : moveTarget.assetSourcePaths[0] ?? moveTarget.sourcePath
            : ASSETS_ROOT
        }
        sourcePath={moveTarget?.sourcePath ?? ASSETS_ROOT}
        folderTree={folderTree}
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
