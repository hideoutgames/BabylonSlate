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
  SelectableText,
  useContextMenu,
} from "@babylonslate/editor-kit";
import { documentId, labelFromPath } from "@babylonslate/core";
import { pickImportFiles } from "@babylonslate/vfs";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
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
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
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
  filterAssets,
  folderRelativePath,
  newAssetFileName,
  textureCompressionState,
  uniqueAssetTypes,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import { revealAssetFromTarget } from "../lib/search-navigation";

const PROJECT_ROOT_ID = "project";
const ASSETS_ROOT = "assets";

type DeleteTarget =
  | { kind: "assets"; guids: string[] }
  | { kind: "folder"; path: string; guids: string[] };

interface TilePressState {
  pointerId: number;
  guid: string;
  startX: number;
  startY: number;
  timerId: ReturnType<typeof setTimeout>;
}

function FolderTreeNode({
  node,
  selectedPath,
  onSelect,
  onRequestDelete,
  depth,
}: {
  node: FolderNode;
  selectedPath: string;
  onSelect: (path: string) => void;
  onRequestDelete: (path: string) => void;
  depth: number;
}) {
  const selected = node.path === selectedPath;
  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant={selected ? "secondary" : "ghost"}
        size="touch"
        data-testid={`folder-node-${node.path}`}
        className={cn(
          "w-full justify-start rounded-md border-l-2 px-2 text-left",
          selected ? "border-l-primary" : "border-l-transparent",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(node.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(node.path);
          onRequestDelete(node.path);
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
          onSelect={onSelect}
          onRequestDelete={onRequestDelete}
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
  onToggleSelect,
  onLongPressMenu,
  thumbnailUrl,
  hasCompileError = false,
}: {
  asset: IndexedAsset;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onLongPressMenu: (clientX: number, clientY: number) => void;
  thumbnailUrl: string | null;
  hasCompileError?: boolean;
}) {
  const pressRef = useRef<TilePressState | null>(null);
  const compression = textureCompressionState(asset);

  const clearPress = () => {
    const press = pressRef.current;
    if (press) {
      clearTimeout(press.timerId);
      pressRef.current = null;
    }
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") return;
    clearPress();
    const timerId = setTimeout(() => {
      pressRef.current = null;
      onToggleSelect();
      onLongPressMenu(event.clientX, event.clientY);
    }, CONTEXT_MENU_LONG_PRESS_MS);
    pressRef.current = {
      pointerId: event.pointerId,
      guid: asset.header.guid,
      startX: event.clientX,
      startY: event.clientY,
      timerId,
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      press.startX - event.clientX,
      press.startY - event.clientY,
    );
    if (distance > CONTEXT_MENU_MOVE_TOLERANCE_PX) {
      clearPress();
    }
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const press = pressRef.current;
    if (press && press.pointerId === event.pointerId) {
      clearPress();
    }
  };

  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(ASSET_DRAG_MIME, assetDragPayload(asset));
    event.dataTransfer.effectAllowed = "copy";
  };

  return (
    <Card
      className={`relative gap-0 overflow-hidden py-0 ${
        selected ? "border-primary ring-1 ring-primary" : ""
      }`}
    >
      <button
        type="button"
        draggable
        data-testid={`content-item-${asset.path}`}
        data-asset-path={asset.path}
        data-asset-guid={asset.header.guid}
        data-selected={selected ? "true" : "false"}
        className="flex min-h-[var(--touch-target,44px)] w-full flex-col gap-1 p-3 text-left hover:bg-accent/50"
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          onToggleSelect();
          onLongPressMenu(event.clientX, event.clientY);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragStart={onDragStart}
      >
        <CardHeader className="flex flex-row items-start gap-2 space-y-0 p-0">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              data-testid={`content-item-thumb-${asset.header.guid}`}
              className="mt-0.5 size-10 shrink-0 rounded-sm object-cover"
            />
          ) : (
            <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-sm font-medium">
              <SelectableText>{asset.header.name}</SelectableText>
            </CardTitle>
            <CardDescription className="truncate text-xs">
              {asset.header.type}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1 p-0 pt-1">
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
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
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
    | { kind: "move"; guid: string; value: string }
    | { kind: "folder"; value: string }
    | null
  >(null);
  const [refsSummary, setRefsSummary] = useState<{
    name: string;
    inbound: string;
    outbound: string;
  } | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>(
    {},
  );
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
    setTypeFilter(null);
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
        typeFilter,
        search,
      }),
    [allAssets, folderGuids, search, typeFilter],
  );

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

  const toggleGuid = useCallback((guid: string) => {
    setSelectedGuids((current) => {
      const next = new Set(current);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }, []);

  const requestDelete = useCallback((guids: string[]) => {
    if (guids.length === 0) return;
    setDeleteTarget({ kind: "assets", guids });
  }, []);

  const requestDeleteFolder = useCallback(
    (path: string) => {
      if (!folderTree || path === ASSETS_ROOT) return;
      const guids = [...collectFolderGuids(path, folderTree)];
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
          const folder = asset.path.includes("/")
            ? asset.path.slice(
                ASSETS_ROOT.length + 1,
                asset.path.lastIndexOf("/"),
              )
            : "";
          setNameDialog({
            kind: "move",
            guid,
            value: folder,
          });
        },
      },
      {
        id: "copy",
        label: "Copy to folder…",
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
        label: "Retry encoding",
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
      setBusy(true);
      try {
        const folder = folderRelativePath(selectedFolderPath, ASSETS_ROOT);
        for (const file of files) {
          await assetRegistry.importFile(
            PROJECT_ROOT_ID,
            folder,
            file.name,
            file.bytes,
          );
        }
        await refreshAssetRegistry();
      } finally {
        setBusy(false);
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
      } else if (nameDialog.kind === "move") {
        const before = assetRegistry.getByGuid(nameDialog.guid);
        if (!before) return;
        const fileName = before.path.slice(before.path.lastIndexOf("/") + 1);
        const folder = nameDialog.value.trim().replace(/^\/+|\/+$/g, "");
        const relative = folder ? `${folder}/${fileName}` : fileName;
        const moved = await assetRegistry.moveAsset(
          nameDialog.guid,
          PROJECT_ROOT_ID,
          relative,
        );
        repairDocumentPath(before.path, moved.path, moved.header.type);
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

  const handleImport = useCallback(async () => {
    const files = await pickImportFiles({ multiple: true });
    await importPickedFiles(files);
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
    if (!assetRegistry) return;
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
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Content Browser
          </h2>
          <p className="text-xs text-muted-foreground">
            {projectDocument.metadata.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="touch"
            data-testid="content-browser-import"
            disabled={busy}
            onClick={() => void handleImport()}
          >
            <UploadIcon data-icon="inline-start" />
            Import
          </Button>
          <Button
            type="button"
            variant="outline"
            size="touch"
            data-testid="content-browser-new-folder"
            disabled={busy}
            onClick={() =>
              setNameDialog({ kind: "folder", value: "NewFolder" })
            }
          >
            <FolderPlusIcon data-icon="inline-start" />
            New Folder
          </Button>
          <Button
            type="button"
            size="touch"
            data-testid="content-browser-new-asset"
            disabled={busy}
            onClick={() => setNewAssetOpen(true)}
          >
            <PlusIcon data-icon="inline-start" />
            New Asset
          </Button>
          {selectedGuids.size > 0 ? (
            <Button
              type="button"
              variant="destructive"
              size="touch"
              data-testid="content-browser-delete-selected"
              disabled={busy}
              onClick={() => requestDelete([...selectedGuids])}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete ({selectedGuids.size})
            </Button>
          ) : null}
        </div>
        {/* Capacitor-free Playwright / automated import path (UI uses pickImportFiles). */}
        <input
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
          <FolderTreeNode
            node={folderTree}
            selectedPath={selectedFolderPath}
            onSelect={setSelectedFolderPath}
            onRequestDelete={requestDeleteFolder}
            depth={0}
          />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search assets…"
              className="min-h-[var(--touch-target,44px)]"
              data-testid="content-browser-search"
            />
            <ToggleGroup
              variant="outline"
              size="touch"
              spacing={1}
              className="flex-wrap"
              data-testid="content-browser-type-filters"
              value={[typeFilter ?? "all"]}
              onValueChange={(value) => {
                const next = value[0];
                setTypeFilter(!next || next === "all" ? null : next);
              }}
              aria-label="Asset type filter"
            >
              <ToggleGroupItem value="all" data-testid="content-browser-filter-all">
                All
              </ToggleGroupItem>
              {typeChips.map((type) => (
                <ToggleGroupItem
                  key={type}
                  value={type}
                  data-testid={`content-browser-filter-${type}`}
                >
                  {type}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div
            className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 overflow-y-auto overscroll-y-contain p-4"
            data-testid="content-browser-asset-grid"
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
                onOpen={() => {
                  if (selectedGuids.size > 0) {
                    toggleGuid(asset.header.guid);
                    return;
                  }
                  void openOrFocusDocument(asset);
                }}
                onToggleSelect={() => toggleGuid(asset.header.guid)}
                onLongPressMenu={(x, y) => openTileMenu(asset.header.guid, x, y)}
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
                <SelectTrigger id="new-asset-type" className="min-h-[var(--touch-target,44px)] w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATABLE_ASSET_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-asset-name">Name</FieldLabel>
              <Input
                id="new-asset-name"
                className="min-h-[var(--touch-target,44px)]"
                value={newAssetName}
                onChange={(event) => setNewAssetName(event.target.value)}
              />
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
              disabled={busy}
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
              {nameDialog?.kind === "folder"
                ? "New Folder"
                : nameDialog?.kind === "rename"
                  ? "Rename Asset"
                  : "Move Asset"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nameDialog?.kind === "move"
                ? "Destination folder relative to assets/ (leave empty for the assets root)."
                : nameDialog?.kind === "folder"
                  ? "Create a folder under the current selection."
                  : "Rename the asset file. References by guid stay intact."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            className="min-h-[var(--touch-target,44px)]"
            data-testid="content-browser-name-input"
            value={nameDialog?.value ?? ""}
            onChange={(event) =>
              setNameDialog((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
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
    </div>
  );
}
