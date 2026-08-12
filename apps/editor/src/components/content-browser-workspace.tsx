import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  ListFilterIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import type { FolderNode, IndexedAsset } from "@babylonslate/assets";
import { newAssetGuid } from "@babylonslate/assets";
import {
  ContextMenuOverlay,
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
  SearchInput,
  SelectableText,
  TreeView,
  useContextMenu,
} from "@babylonslate/editor-kit";
import { documentId, labelFromPath } from "@babylonslate/core";
import { isMobilePlatform, pickImportFiles } from "@babylonslate/vfs";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
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
  DialogFooter,
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
  ASSET_DRAG_MIME,
  CREATABLE_ASSET_TYPES,
  ENGINE_BASE_CLASSES,
  assetDragPayload,
  buildNewAssetResult,
  collectFolderGuids,
  compressionBadgeLabel,
  defaultParentClassForType,
  displayAssetTitle,
  filterAssets,
  flattenFolderTree,
  folderRelativePath,
  isFolderNameTaken,
  isNewAssetNameTaken,
  isRenameNameTaken,
  newAssetFileName,
  textureCompressionState,
  uniqueAssetTypes,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import { revealAssetFromTarget } from "../lib/search-navigation";

const PROJECT_ROOT_ID = "project";
const ASSETS_ROOT = "assets";
const FOLDER_DRAG_MIME = "application/x-babylonslate-folder";

type DeleteTarget =
  | { kind: "assets"; guids: string[] }
  | { kind: "folder"; path: string; guids: string[] };

interface TilePressState {
  pointerId: number;
  guid: string;
  startX: number;
  startY: number;
  startedAt: number;
  menuTimerId: ReturnType<typeof setTimeout>;
  dragTimerId: ReturnType<typeof setTimeout>;
  armed: boolean;
}

function FolderTreeNode({
  node,
  selectedPath,
  dropPath,
  onSelect,
  onRequestDelete,
  onDropAsset,
  onDropFolder,
  onFolderDragStart,
  depth,
}: {
  node: FolderNode;
  selectedPath: string;
  dropPath: string | null;
  onSelect: (path: string) => void;
  onRequestDelete: (path: string) => void;
  onDropAsset: (guid: string, folderPath: string) => void;
  onDropFolder: (fromPath: string, toPath: string) => void;
  onFolderDragStart: (path: string, event: DragEvent) => void;
  depth: number;
}) {
  const selected = node.path === selectedPath;
  const dropTarget = dropPath === node.path;

  const acceptDrop = (event: DragEvent) => {
    if (
      event.dataTransfer.types.includes(ASSET_DRAG_MIME) ||
      event.dataTransfer.types.includes(FOLDER_DRAG_MIME)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  };

  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant={selected ? "secondary" : "ghost"}
        size="sm"
        draggable={node.path !== ASSETS_ROOT}
        data-testid={`folder-node-${node.path}`}
        data-folder-path={node.path}
        className={cn(
          "w-full justify-start rounded-md border-l-2 px-2 text-left",
          selected ? "border-l-primary" : "border-l-transparent",
          dropTarget && "bg-accent",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(node.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(node.path);
          onRequestDelete(node.path);
        }}
        onDragStart={(event) => onFolderDragStart(node.path, event)}
        onDragOver={acceptDrop}
        onDrop={(event) => {
          event.preventDefault();
          const assetGuid = event.dataTransfer.getData(ASSET_DRAG_MIME);
          if (assetGuid) {
            try {
              const payload = JSON.parse(assetGuid) as { guid?: string };
              if (payload.guid) onDropAsset(payload.guid, node.path);
            } catch {
              onDropAsset(assetGuid, node.path);
            }
            return;
          }
          const fromPath = event.dataTransfer.getData(FOLDER_DRAG_MIME);
          if (fromPath) onDropFolder(fromPath, node.path);
        }}
      >
        <FolderIcon data-icon="inline-start" />
        <SelectableText className="truncate">{node.name}</SelectableText>
      </Button>
      {node.children.map((child) => (
        <FolderTreeNode
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          dropPath={dropPath}
          onSelect={onSelect}
          onRequestDelete={onRequestDelete}
          onDropAsset={onDropAsset}
          onDropFolder={onDropFolder}
          onFolderDragStart={onFolderDragStart}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function AssetTile({
  asset,
  selected,
  onOpen,
  onSelect,
  onLongPressMenu,
  onArmedDrag,
  onDropAsset,
  thumbnailUrl,
  hasCompileError = false,
}: {
  asset: IndexedAsset;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
  onArmedDrag: (guid: string) => void;
  onDropAsset: (guid: string, folderPath: string) => void;
  thumbnailUrl: string | null;
  hasCompileError?: boolean;
}) {
  const pressRef = useRef<TilePressState | null>(null);
  const compression = textureCompressionState(asset);
  const folderPath = asset.path.includes("/")
    ? asset.path.slice(0, asset.path.lastIndexOf("/"))
    : ASSETS_ROOT;

  const clearPress = () => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.menuTimerId);
      clearTimeout(press.dragTimerId);
      pressRef.current = null;
    }
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") return;
    clearPress();
    const dragTimerId = setTimeout(() => {
      const press = pressRef.current;
      if (!press) return;
      press.armed = true;
      onArmedDrag(asset.header.guid);
    }, DRAG_ARM_MS);
    const menuTimerId = setTimeout(() => {
      const press = pressRef.current;
      if (!press || press.armed) return;
      pressRef.current = null;
      onSelect();
      onLongPressMenu(event.clientX, event.clientY);
    }, CONTEXT_MENU_LONG_PRESS_MS);
    pressRef.current = {
      pointerId: event.pointerId,
      guid: asset.header.guid,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: Date.now(),
      menuTimerId,
      dragTimerId,
      armed: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      press.startX - event.clientX,
      press.startY - event.clientY,
    );
    if (distance <= CONTEXT_MENU_MOVE_TOLERANCE_PX) return;
    if (!press.armed) {
      clearPress();
      return;
    }
    clearTimeout(press.menuTimerId);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const press = pressRef.current;
    if (press && press.pointerId === event.pointerId) {
      if (press.armed) {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const dropFolder =
          target?.closest("[data-folder-path]")?.getAttribute("data-folder-path") ??
          target?.closest("[data-asset-folder]")?.getAttribute("data-asset-folder");
        if (dropFolder) onDropAsset(asset.header.guid, dropFolder);
      }
      clearPress();
    }
  };

  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(ASSET_DRAG_MIME, assetDragPayload(asset));
    event.dataTransfer.effectAllowed = "copyMove";
  };

  return (
    <Card
      size="sm"
      className={cn(
        "relative w-full gap-0 overflow-hidden py-0",
        selected ? "border-primary ring-1 ring-primary" : "",
      )}
      data-asset-folder={folderPath}
    >
      <button
        type="button"
        draggable
        data-testid={`content-item-${asset.path}`}
        data-asset-path={asset.path}
        data-asset-guid={asset.header.guid}
        data-selected={selected ? "true" : "false"}
        className="flex w-full flex-col text-left hover:bg-accent/50"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onDoubleClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
          onLongPressMenu(event.clientX, event.clientY);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragStart={onDragStart}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(ASSET_DRAG_MIME)) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const raw = event.dataTransfer.getData(ASSET_DRAG_MIME);
          if (!raw) return;
          try {
            const payload = JSON.parse(raw) as { guid?: string };
            if (payload.guid && payload.guid !== asset.header.guid) {
              onDropAsset(payload.guid, folderPath);
            }
          } catch {
            /* ignore malformed payloads */
          }
        }}
      >
        <div className="aspect-square w-full bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              data-testid={`content-item-thumb-${asset.header.guid}`}
              className="size-full object-cover"
            />
          ) : (
            <FileIcon className="size-full p-4 text-muted-foreground" />
          )}
        </div>
        <CardHeader className="gap-0.5 p-1.5">
          <CardTitle className="truncate text-xs font-medium">
            <SelectableText>{displayAssetTitle(asset.header.name)}</SelectableText>
          </CardTitle>
          <CardDescription className="truncate text-[10px]">
            {asset.header.type}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1 px-1.5 pb-1.5">
          {compression ? (
            <Badge variant="secondary" className="w-fit text-[10px]">
              {compressionBadgeLabel(compression)}
            </Badge>
          ) : null}
          {hasCompileError ? (
            <Badge
              variant="destructive"
              className="w-fit text-[10px]"
              data-testid={`compile-error-overlay-${asset.header.guid}`}
            >
              Compile error
            </Badge>
          ) : null}
          <span data-lock-slot className="hidden" aria-hidden />
        </CardContent>
      </button>
    </Card>
  );
}

export function ContentBrowserWorkspace() {
  const {
    projectDocument,
    assetRegistry,
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
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [newAssetOpen, setNewAssetOpen] = useState(false);
  const [newAssetType, setNewAssetType] =
    useState<CreatableAssetType>("Texture");
  const [newAssetName, setNewAssetName] = useState("NewAsset");
  const [newAssetParent, setNewAssetParent] = useState("BObject");
  const [busy, setBusy] = useState(false);
  const [nameDialog, setNameDialog] = useState<
    | { kind: "rename"; guid: string; value: string }
    | { kind: "folder"; value: string }
    | null
  >(null);
  const [moveTarget, setMoveTarget] = useState<{
    guid: string;
    folderPath: string;
  } | null>(null);
  const [moveCollapsed, setMoveCollapsed] = useState<Set<string>>(
    () => new Set(),
  );
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
  const importInputRef = useRef<HTMLInputElement>(null);
  const thumbnailUrlsRef = useRef(thumbnailUrls);
  thumbnailUrlsRef.current = thumbnailUrls;
  const menuTargetGuidsRef = useRef<string[]>([]);

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
    clearPendingTarget();
  }, [clearPendingTarget, pendingTarget]);

  const folderTree = useMemo(
    () => assetRegistry?.folderTree(PROJECT_ROOT_ID) ?? null,
    [assetRegistry],
  );

  const allAssets = useMemo(
    () => assetRegistry?.list({ rootId: PROJECT_ROOT_ID }) ?? [],
    [assetRegistry],
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
      if (asset.header.type === "Scene") {
        const path = asset.path;
        const id = documentId({ kind: "scene", path });
        if (openIds.has(id)) {
          setActiveDocument(id);
          return;
        }
        await openDocument({
          kind: "scene",
          path,
          label: labelFromPath(path),
        });
        return;
      }
      if (asset.header.type === "Graph") {
        const path = asset.path;
        const id = documentId({ kind: "graph", path });
        if (openIds.has(id)) {
          setActiveDocument(id);
          return;
        }
        await openDocument({
          kind: "graph",
          path,
          label: labelFromPath(path),
        });
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

  const repairDocumentPath = useCallback(
    (oldPath: string, newPath: string, type: string) => {
      if (oldPath === newPath) return;
      if (type === "Scene") repathDocument("scene", oldPath, newPath);
      if (type === "Graph") repathDocument("graph", oldPath, newPath);
    },
    [repathDocument],
  );

  const contextItems = useMemo(
    () => [
      {
        id: "duplicate",
        label: "Duplicate",
        onSelect: () => {
          void (async () => {
            if (!assetRegistry) return;
            const folder = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
            for (const guid of menuTargetGuidsRef.current) {
              await assetRegistry.duplicateAsset(guid, PROJECT_ROOT_ID, folder);
            }
            await refreshAssetRegistry();
          })();
        },
      },
      {
        id: "rename",
        label: "Rename",
        onSelect: () => {
          const guid = menuTargetGuidsRef.current[0];
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
        id: "move",
        label: "Move…",
        onSelect: () => {
          const guid = menuTargetGuidsRef.current[0];
          if (!guid || !assetRegistry) return;
          const asset = assetRegistry.getByGuid(guid);
          if (!asset) return;
          const folderPath = asset.path.includes("/")
            ? asset.path.slice(0, asset.path.lastIndexOf("/"))
            : ASSETS_ROOT;
          setMoveTarget({
            guid,
            folderPath: folderPath || ASSETS_ROOT,
          });
        },
      },
      {
        id: "copy",
        label: "Copy to Folder…",
        onSelect: () => {
          void (async () => {
            if (!assetRegistry) return;
            const folder = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
            for (const guid of menuTargetGuidsRef.current) {
              await assetRegistry.copyAsset(guid, PROJECT_ROOT_ID, folder);
            }
            await refreshAssetRegistry();
          })();
        },
      },
      {
        id: "show-references",
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
        id: "retry-encoding",
        label: "Retry Encoding",
        onSelect: () => {
          void (async () => {
            if (!assetRegistry) return;
            for (const guid of menuTargetGuidsRef.current) {
              await assetRegistry.retryTextureEncoding(guid);
            }
            await refreshAssetRegistry();
          })();
        },
      },
      {
        id: "delete",
        label: "Delete",
        onSelect: () => requestDelete(menuTargetGuidsRef.current),
      },
    ],
    [
      assetRegistry,
      refreshAssetRegistry,
      requestDelete,
      selectedFolderPath,
    ],
  );

  const { menu, closeMenu, openMenuAt, bind } = useContextMenu({
    items: contextItems,
  });

  const openTileMenu = useCallback(
    (guid: string, clientX: number, clientY: number) => {
      setSelectedGuids((current) => {
        const next = new Set(current);
        if (!next.has(guid)) {
          next.add(guid);
        }
        menuTargetGuidsRef.current = [...next];
        return next;
      });
      openMenuAt(clientX, clientY);
    },
    [openMenuAt],
  );

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
      if (deleteTarget.kind === "folder") {
        const relative = folderRelativePath(deleteTarget.path, ASSETS_ROOT);
        await assetRegistry.deleteFolder(PROJECT_ROOT_ID, relative);
        if (selectedFolderPath === deleteTarget.path) {
          setSelectedFolderPath(ASSETS_ROOT);
        }
      } else {
        for (const guid of deleteTarget.guids) {
          await assetRegistry.deleteAsset(guid);
        }
      }
      setSelectedGuids(new Set());
      setDeleteTarget(null);
      await refreshAssetRegistry();
    } finally {
      setBusy(false);
    }
  }, [
    assetRegistry,
    deleteTarget,
    refreshAssetRegistry,
    selectedFolderPath,
  ]);

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
    refreshAssetRegistry,
    repairDocumentPath,
    selectedFolderPath,
  ]);

  const confirmMove = useCallback(async () => {
    if (!assetRegistry || !moveTarget) return;
    setBusy(true);
    try {
      const before = assetRegistry.getByGuid(moveTarget.guid);
      if (!before) return;
      const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
      const folder = folderRelativePath(moveTarget.folderPath, ASSETS_ROOT);
      const relative = folder ? `${folder}/${fileName}` : fileName;
      const moved = await assetRegistry.moveAsset(
        moveTarget.guid,
        PROJECT_ROOT_ID,
        relative,
      );
      repairDocumentPath(before.path, moved.path, moved.header.type);
      await refreshAssetRegistry();
      setMoveTarget(null);
    } finally {
      setBusy(false);
    }
  }, [assetRegistry, moveTarget, refreshAssetRegistry, repairDocumentPath]);

  const dropAssetOnFolder = useCallback(
    async (guid: string, folderPath: string) => {
      if (!assetRegistry) return;
      const before = assetRegistry.getByGuid(guid);
      if (!before) return;
      const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
      const folder = folderRelativePath(folderPath, ASSETS_ROOT);
      const relative = folder ? `${folder}/${fileName}` : fileName;
      if (relative === before.path.replace(/^assets\//, "") || `assets/${relative}` === before.path) {
        return;
      }
      setBusy(true);
      try {
        const moved = await assetRegistry.moveAsset(
          guid,
          PROJECT_ROOT_ID,
          relative,
        );
        repairDocumentPath(before.path, moved.path, moved.header.type);
        await refreshAssetRegistry();
      } finally {
        setBusy(false);
      }
    },
    [assetRegistry, refreshAssetRegistry, repairDocumentPath],
  );

  const dropFolderOnFolder = useCallback(
    async (fromPath: string, toPath: string) => {
      if (!assetRegistry || fromPath === ASSETS_ROOT || fromPath === toPath) return;
      if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) return;
      const relative = folderRelativePath(fromPath, ASSETS_ROOT);
      const parent = folderRelativePath(toPath, ASSETS_ROOT);
      setBusy(true);
      try {
        await assetRegistry.moveFolder(PROJECT_ROOT_ID, relative, parent);
        await refreshAssetRegistry();
      } finally {
        setBusy(false);
      }
    },
    [assetRegistry, refreshAssetRegistry],
  );

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
    setBusy(true);
    try {
      const type = newAssetType;
      const name = newAssetName.trim() || "NewAsset";
      const relative = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
      const fileName = newAssetFileName(type, name);
      const result = buildNewAssetResult({
        type,
        name,
        guid: newAssetGuid(),
        parentClass:
          type === "Class"
            ? newAssetParent
            : defaultParentClassForType(type),
      });
      await assetRegistry.createAsset(
        PROJECT_ROOT_ID,
        relative ? `${relative}/${fileName}` : fileName,
        result,
      );
      setNewAssetOpen(false);
      await refreshAssetRegistry();
    } finally {
      setBusy(false);
    }
  }, [
    assetRegistry,
    newAssetName,
    newAssetNameTaken,
    newAssetParent,
    newAssetType,
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
      {...bind}
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
          onClick={() => setNewAssetOpen(true)}
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
                  {type}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedGuids.size > 0 ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="content-browser-delete-selected"
            disabled={busy}
            onClick={() => requestDelete([...selectedGuids])}
          >
            <Trash2Icon data-icon="inline-start" />
            Delete ({selectedGuids.size})
          </Button>
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
          className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto overscroll-y-contain border-r border-border p-2"
          data-testid="content-browser-folder-tree"
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
          {folderTree ? (
            <FolderTreeNode
              node={folderTree}
              selectedPath={selectedFolderPath}
              dropPath={null}
              onSelect={setSelectedFolderPath}
              onRequestDelete={requestDeleteFolder}
              onDropAsset={(guid, folderPath) => {
                void dropAssetOnFolder(guid, folderPath);
              }}
              onDropFolder={(fromPath, toPath) => {
                void dropFolderOnFolder(fromPath, toPath);
              }}
              onFolderDragStart={(path, event) => {
                if (path === ASSETS_ROOT) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.setData(FOLDER_DRAG_MIME, path);
                event.dataTransfer.effectAllowed = "move";
              }}
              depth={0}
            />
          ) : null}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,7rem)] content-start gap-2 overflow-y-auto overscroll-y-contain p-3"
            data-testid="content-browser-asset-grid"
            onClick={() => setSelectedGuids(new Set())}
          >
            {visibleAssets.map((asset) => (
              <AssetTile
                key={asset.header.guid}
                asset={asset}
                selected={selectedGuids.has(asset.header.guid)}
                thumbnailUrl={thumbnailUrls[asset.header.guid] ?? null}
                hasCompileError={
                  compileErrorGuids.has(asset.header.guid) ||
                  compileErrorGuids.has(asset.path)
                }
                onSelect={() =>
                  setSelectedGuids(new Set([asset.header.guid]))
                }
                onOpen={() => void openOrFocusDocument(asset)}
                onLongPressMenu={(x, y) => openTileMenu(asset.header.guid, x, y)}
                onArmedDrag={() => {
                  setSelectedGuids(new Set([asset.header.guid]));
                }}
                onDropAsset={(guid, folderPath) => {
                  void dropAssetOnFolder(guid, folderPath);
                }}
              />
            ))}
            {visibleAssets.length === 0 ? (
              <p className="col-span-full text-sm text-muted-foreground">
                No assets in this folder match the current filters.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <ContextMenuOverlay menu={menu} onClose={closeMenu} />

      <AlertDialog open={newAssetOpen} onOpenChange={setNewAssetOpen}>
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
                      {type}
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
                  <SelectTrigger id="new-asset-parent" className="min-h-[var(--touch-target,44px)] w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENGINE_BASE_CLASSES.map((base) => (
                      <SelectItem key={base} value={base}>
                        {base}
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
                : "Delete assets?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "folder"
                ? `Folder ${deleteTarget.path} and its assets will be removed permanently. This action is not undoable.`
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
              {nameDialog?.kind === "folder" ? "New Folder" : "Rename Asset"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nameDialog?.kind === "folder"
                ? "Create a folder under the current selection."
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

      <Dialog
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null);
        }}
      >
        <DialogContent data-testid="content-browser-move-dialog">
          <DialogHeader>
            <DialogTitle>Move Asset</DialogTitle>
            <DialogDescription>
              Choose a destination folder in the project.
            </DialogDescription>
          </DialogHeader>
          <div className="h-64 min-h-0">
            <TreeView
              nodes={flattenFolderTree(folderTree, moveCollapsed).map(
                (row) => ({
                  id: row.id,
                  label: row.label,
                  depth: row.depth,
                  hasChildren: row.hasChildren,
                  expanded: row.expanded,
                }),
              )}
              selectedId={moveTarget?.folderPath ?? null}
              onSelect={(id) =>
                setMoveTarget((current) =>
                  current ? { ...current, folderPath: id } : current,
                )
              }
              onToggleExpanded={(id) =>
                setMoveCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              emptyLabel="No folders"
              data-testid="content-browser-move-tree"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMoveTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="content-browser-move-confirm"
              disabled={busy || !moveTarget}
              onClick={() => void confirmMove()}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
