import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { IndexedAsset } from "@haptic/assets";
import {
  normalizeAnimationPayload,
  normalizeSkeletonPayload,
} from "@haptic/assets";
import { animationRetargetMatchingClips } from "@haptic/render";
import {
  ContextMenuOverlay,
  AssetPicker,
} from "@haptic/editor-kit";
import { AssetReferenceDialog } from "./asset-reference-dialog";
import { openOrFocusAssetDocument } from "../lib/open-asset-document";
import {
  ASSET_DOCUMENT_KINDS,
  documentKindForAssetType,
  CONTENT_BROWSER_ID,
  type DocumentKind,
} from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@haptic/ui/components/resizable";
import { cn } from "@haptic/ui/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import {
  useActiveDocumentId,
  useDocumentActions,
  useDocumentKindsRevision,
  useEditorShellState,
  useProjectState,
  useRegistryState,
  useSourceControl,
  useTabOrder,
} from "../context/document-context";
import type { OpenDocument } from "../services/document-service";
import { useOptionalPlay } from "../context/play-context";
import {
  applyLockTransfers,
  folderMoveLockTransfers,
  refuseTheirsPaths,
} from "../lib/source-control-file-ops";
import { useKeybindCommand, useKeybindings } from "../context/keybind-context";
import { useProjectSearch } from "../context/project-search-context";
import { useValidation } from "../context/validation-context";
import {
  ASSETS_ROOT,
  applyContentBrowserTileSelect,
  type ContentBrowserSortMode,
  type CreatableAssetType,
  type DeleteTarget,
} from "../lib/content-browser-helpers";
import { revealAssetFromTarget } from "../lib/search-navigation";
import { writeRetargetedAnimations } from "../lib/animation-retarget";
import { useContentBrowserPaintSelect } from "../lib/use-content-browser-paint-select";
import type { ContentBrowserGridActions } from "./content-browser-grid-tiles";
import { ContentBrowserMoveDialog } from "./content-browser-move-dialog";
import { ContentBrowserCopyProgressDialog } from "./content-browser-copy-progress-dialog";
import { ImportProgressDialog } from "./import-progress-dialog";
import { ContentBrowserNewAssetDialog } from "./content-browser-new-asset-dialog";
import { ContentBrowserSelectionActions } from "./content-browser-selection-actions";
import { usePhoneLayout, usePhoneTouchSizing } from "../shell/use-platform-layout";
import { ContentBrowserDeleteDialogs } from "./content-browser-delete-dialogs";
import { ContentBrowserNameDialog, type NameEntry } from "./content-browser-name-dialog";
import { ContentBrowserResultDialogs } from "./content-browser-result-dialogs";
import { useContentBrowserModel } from "./content-browser-model";
import { useContentBrowserTreeState } from "./content-browser-tree-state";
import { useContentBrowserMountedTiles } from "./content-browser-mounted-tiles";
import { useContentBrowserDeleteFlow } from "./content-browser-delete-flow";
import { useContentBrowserMoveFlow, type MoveTarget } from "./content-browser-move-flow";
import { useContentBrowserImportFlow } from "./content-browser-import-flow";
import { useContentBrowserNameFlow } from "./content-browser-name-flow";
import { useContentBrowserNewAssetFlow } from "./content-browser-new-asset-flow";
import { useContentBrowserContextMenus } from "./content-browser-context-menus";
import { ContentBrowserToolbar } from "./content-browser-toolbar";
import { ContentBrowserFolderNavigation } from "./content-browser-folder-navigation";
import { ContentBrowserAssetPane } from "./content-browser-asset-pane";

const ALL_DOCUMENT_KINDS: readonly DocumentKind[] = ["content-browser", ...ASSET_DOCUMENT_KINDS];
const NO_DOCUMENT_KINDS: readonly DocumentKind[] = [];
const NO_OPEN_DOCUMENTS: OpenDocument[] = [];

type ContentBrowserWorkspaceBodyProps = {
  hidden: boolean;
  actions: ReturnType<typeof useDocumentActions>;
  registry: ReturnType<typeof useRegistryState>;
  projectDocument: ReturnType<typeof useProjectState>["projectDocument"];
  thumbnailVersions: ReturnType<typeof useEditorShellState>["thumbnailVersions"];
  thumbnailsEnabled: boolean;
  sourceControl: ReturnType<typeof useSourceControl>["sourceControl"];
  activeDocumentId: string | null;
  tabOrder: readonly string[];
  diagnostics: ReturnType<typeof useValidation>["diagnostics"];
};

function ContentBrowserWorkspaceBody({
  hidden,
  actions,
  registry,
  projectDocument,
  thumbnailVersions,
  thumbnailsEnabled,
  sourceControl,
  activeDocumentId,
  tabOrder,
  diagnostics,
}: ContentBrowserWorkspaceBodyProps) {
  const phone = usePhoneLayout();
  // Phone toolbar buttons are icon-only; their size follows Compact Mode.
  const touchSizing = usePhoneTouchSizing();
  const phoneIconSize = touchSizing ? "touch-icon" : "icon-sm";
  const [foldersOpen, setFoldersOpen] = useState(false);
  useEffect(() => {
    if (hidden || !phone) setFoldersOpen(false);
  }, [hidden, phone]);
  const { projectGuid, assetRegistry, registryEpoch, encodingTextures, pluginDescriptors, showPluginContent } = registry;
  const {
    refreshAssetRegistry,
    noteAssetsCreated,
    renameAsset,
    repathDocument,
    repathProjectFolder,
    openDocument,
    closeDocumentsForPaths,
    repairAfterAssetDelete,
    replaceClassReferencesBeforeDelete,
    getOpenDocuments,
    setActiveDocument,
    loadAssetThumbnail,
    readAssetChunk,
  } = actions;
  const play = useOptionalPlay();
  const { pendingTarget, clearPendingTarget } = useProjectSearch();
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
  const [tileAnchorKey, setTileAnchorKey] = useState<string | null>(null);
  // The dialog states the flows share stay here: they decide which operation
  // dialog is open and whether the open documents are read.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [newAssetOpen, setNewAssetOpen] = useState(false);
  const [newAssetType, setNewAssetType] =
    useState<CreatableAssetType>("Scene");
  const [nameDialog, setNameDialog] = useState<NameEntry | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [referenceGuid, setReferenceGuid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  // Open tabs mutate in place, so the dialogs that read their unsaved content
  // follow the document revisions, but only while one of them is showing.
  const dialogNeedsOpenDocuments = deleteTarget !== null || referenceGuid !== null ||
    (newAssetOpen && (newAssetType === "DataDefinition" || newAssetType === "DataTree"));
  const openDocumentsRevision = useDocumentKindsRevision(dialogNeedsOpenDocuments ? ALL_DOCUMENT_KINDS : NO_DOCUMENT_KINDS);
  const openDocuments = useMemo(() => {
    void openDocumentsRevision;
    return dialogNeedsOpenDocuments ? getOpenDocuments() : NO_OPEN_DOCUMENTS;
  }, [dialogNeedsOpenDocuments, openDocumentsRevision, getOpenDocuments]);
  const [retargetPickerOpen, setRetargetPickerOpen] = useState(false);
  const [retargetErrors, setRetargetErrors] = useState<string[] | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const menuTargetGuidsRef = useRef<string[]>([]);
  const menuTargetFoldersRef = useRef<string[]>([]);
  const operationDialog = newAssetOpen ? "create" : nameDialog ? "name" : moveTarget ? "move" : deleteTarget ? "delete" : null;

  useEffect(() => {
    if (operationDialog) setOperationError(null);
  }, [operationDialog]);

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

  const {
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
  } = useContentBrowserModel({
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
  });

  const handleRetargetSkeleton = useCallback(
    async (skeletonGuid: string | null) => {
      setRetargetPickerOpen(false);
      if (!skeletonGuid || !assetRegistry) return;
      const skeleton = assetRegistry.getByGuid(skeletonGuid);
      if (!skeleton || skeleton.header.type !== "Skeleton") return;
      const skeletonPayload = normalizeSkeletonPayload(skeleton.header.payload);
      const sources = menuTargetGuidsRef.current.flatMap((guid) => {
        const asset = assetRegistry.getByGuid(guid);
        if (!asset || asset.header.type !== "Animation") return [];
        return [
          {
            guid,
            name: asset.header.name,
            payload: normalizeAnimationPayload(asset.header.payload),
          },
        ];
      });
      const engine = play?.ensureSharedEngine();
      if (!engine) {
        setRetargetErrors(["Shared editor Engine is not available."]);
        return;
      }
      setBusy(true);
      try {
        const result = await writeRetargetedAnimations({
          sources,
          targetSkeletonGuid: skeleton.header.guid,
          targetSkeletonName: skeleton.header.name,
          targetModelGuid: skeletonPayload.modelGuid,
          existingNames: allAssets.map((asset) => asset.header.name),
          folderRelative: selectedRoot.relative,
          rootId: selectedRoot.rootId,
          readModelBytes: async (modelGuid) => {
            const model = assetRegistry.getByGuid(modelGuid);
            if (!model) return null;
            return readAssetChunk(model.path, "source");
          },
          probeMatches: (sourceBytes, targetBytes, clipNames) =>
            animationRetargetMatchingClips(engine, sourceBytes, targetBytes, clipNames),
          createAsset: (rootId, relativePath, importResult) =>
            assetRegistry.createAsset(rootId, relativePath, importResult),
        });
        await refreshAssetRegistry();
        if (result.skipped.length > 0) {
          setRetargetErrors(
            result.skipped.map(
              (name) => `${name}: no matching bones on ${skeleton.header.name}`,
            ),
          );
        }
      } catch (error) {
        setRetargetErrors([
          error instanceof Error ? error.message : String(error),
        ]);
      } finally {
        setBusy(false);
      }
    },
    [
      allAssets,
      assetRegistry,
      play,
      readAssetChunk,
      refreshAssetRegistry,
      selectedRoot,
    ],
  );

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

  const {
    browserRows,
    treeSelectedId,
    treeSelectedIds,
    handleTreeSelect,
    toggleFolderExpanded,
  } = useContentBrowserTreeState({
    folderTrees,
    allAssets,
    assetsByGuid,
    selectedFolderPath,
    setSelectedFolderPath,
    selectedGuids,
    setSelectedGuids,
    selectedFolderPaths,
    setSelectedFolderPaths,
  });

  const selectGridTile = useCallback(
    (
      hit: { kind: "asset"; guid: string } | { kind: "folder"; path: string },
      event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    ) => {
      const next = applyContentBrowserTileSelect(
        hit,
        {
          additive: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        },
        orderedTileHits,
        {
          selectedGuids,
          selectedFolderPaths,
          anchorKey: tileAnchorKey,
        },
      );
      setSelectedGuids(next.guids);
      setSelectedFolderPaths(next.folderPaths);
      setTileAnchorKey(next.anchorKey);
    },
    [orderedTileHits, selectedFolderPaths, selectedGuids, tileAnchorKey],
  );

  const { scrollerRef, slice, spacerHeight, thumbnailUrls, tileLocks } = useContentBrowserMountedTiles({
    gridItems,
    hidden,
    classParentOf,
    sourceControl,
    thumbnailsEnabled,
    thumbnailVersions,
    loadAssetThumbnail,
  });

  const selectionCount = selectedGuids.size + selectedFolderPaths.size;

  const openIds = useMemo(() => new Set(tabOrder), [tabOrder]);

  const openOrFocusDocument = useCallback(
    async (asset: IndexedAsset) => {
      try {
        await openOrFocusAssetDocument({
          guid: asset.header.guid,
          getByGuid: () => asset,
          openDocumentIds: openIds,
          setActiveDocument,
          openDocument,
        });
      } catch (error) {
        setOpenError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [openDocument, openIds, setActiveDocument],
  );

  const {
    requestDeleteSnapshot,
    requestDeleteSelection,
    dialogProps: deleteDialogProps,
  } = useContentBrowserDeleteFlow({
    deleteTarget,
    setDeleteTarget,
    assetRegistry,
    allAssets,
    referenceAssets,
    openDocuments,
    folderTrees,
    rootPrefixes,
    browserRoots,
    projectDocument,
    selectedGuids,
    selectedFolderPaths,
    setSelectedFolderPath,
    setSelectedGuids,
    setSelectedFolderPaths,
    busy,
    setBusy,
    setOperationError,
    refuseTheirsAssetPaths,
    sourceControl,
    closeDocumentsForPaths,
    replaceClassReferencesBeforeDelete,
    repairAfterAssetDelete,
  });

  const repairDocumentPath = useCallback(
    (oldPath: string, newPath: string, type: string) => {
      if (oldPath === newPath) return;
      if (type === "Scene") repathDocument("scene", oldPath, newPath);
      const kind = documentKindForAssetType(type);
      if (kind && kind !== "scene") repathDocument(kind, oldPath, newPath);
    },
    [repathDocument],
  );

  const {
    runCopySteps,
    folderAssetCount,
    openMoveForSnapshot,
    handleTreeReparent,
    copyProgressDialogProps,
    dialogKey: moveDialogKey,
    dialogProps: moveDialogProps,
  } = useContentBrowserMoveFlow({
    moveTarget,
    setMoveTarget,
    assetRegistry,
    allAssets,
    folderTrees,
    browserRows,
    browserRoots,
    rootPrefixes,
    readOnlyRootPrefixes,
    existingContentPaths,
    classParentOf,
    pluginDescriptors,
    projectDocument,
    selectedFolderPath,
    setSelectedFolderPath,
    selectedGuids,
    selectedFolderPaths,
    setSelectedFolderPaths,
    menuTargetGuidsRef,
    menuTargetFoldersRef,
    busy,
    setBusy,
    operationError,
    setOperationError,
    refuseTheirsAssetPaths,
    repairDocumentPath,
    transferFolderLocks,
    repathProjectFolder,
    refreshAssetRegistry,
    sourceControl,
  });

  const {
    importAbortRef,
    updateImportProgress,
    setImportProgress,
    setImportErrors,
    importErrors,
    importedFileCount,
    importInputRef,
    handleImport,
    handleImportInputChange,
    progressDialogProps: importProgressDialogProps,
  } = useContentBrowserImportFlow({
    assetRegistry,
    selectedRoot,
    play,
    busy,
    setBusy,
    refreshAssetRegistry,
  });

  const {
    treeRenamingId,
    setTreeRenamingId,
    finishTreeRename,
    dialogProps: nameDialogProps,
  } = useContentBrowserNameFlow({
    nameDialog,
    setNameDialog,
    assetRegistry,
    allAssets,
    referenceAssets,
    existingAssetPaths,
    existingFolderPaths,
    browserRows,
    browserRoots,
    selectedFolderPath,
    setSelectedFolderPath,
    setSelectedFolderPaths,
    selectedRoot,
    busy,
    setBusy,
    operationError,
    setOperationError,
    noteAssetsCreated,
    refreshAssetRegistry,
    renameAsset,
    repathProjectFolder,
    refuseTheirsAssetPaths,
    repairDocumentPath,
    transferFolderLocks,
    sourceControl,
  });

  const {
    openNewAssetMenu,
    menuProps: newAssetMenuProps,
    dialogProps: newAssetDialogProps,
  } = useContentBrowserNewAssetFlow({
    newAssetOpen,
    setNewAssetOpen,
    newAssetType,
    setNewAssetType,
    assetRegistry,
    allAssets,
    referenceAssets,
    openDocuments,
    existingAssetPaths,
    browserRoots,
    folderTrees,
    isReadOnlyFolder,
    classParentOf,
    selectedFolderPath,
    setSelectedFolderPath,
    setSelectedGuids,
    setSelectedFolderPaths,
    selectedRootWritable,
    activeDocumentId,
    getOpenDocuments,
    busy,
    setBusy,
    operationError,
    setOperationError,
    noteAssetsCreated,
    openOrFocusDocument,
  });

  const keybinds = useKeybindings();
  const {
    menu,
    closeMenu,
    emptyGridMenu,
    closeEmptyGridMenu,
    emptyGridBind,
    openTileMenu,
    openFolderMenu,
    runSelectionAction,
  } = useContentBrowserContextMenus({
    menuTargetGuidsRef,
    menuTargetFoldersRef,
    assetRegistry,
    projectGuid,
    projectDocument,
    thumbnailsEnabled,
    selectedFolderPath,
    browserRoots,
    rootPrefixes,
    busy,
    keybinds,
    importAbortRef,
    openOrFocusDocument,
    setImportErrors,
    updateImportProgress,
    setImportProgress,
    refreshAssetRegistry,
    noteAssetsCreated,
    setBusy,
    setOperationError,
    folderAssetCount,
    runCopySteps,
    setNameDialog,
    setRetargetPickerOpen,
    openMoveForSnapshot,
    setReferenceGuid,
    requestDeleteSnapshot,
    selectedRootWritable,
    classParentOf,
    selectedGuids,
    selectedFolderPaths,
    setSelectedGuids,
    setSelectedFolderPaths,
    openNewAssetMenu,
    handleImport,
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

  // Tiles receive reference-stable handlers that forward to the handlers of
  // the latest committed render, so memoized tiles skip unrelated renders.
  const gridHandlersRef = useRef<ContentBrowserGridActions | null>(null);
  useLayoutEffect(() => {
    gridHandlersRef.current = {
      select: selectGridTile,
      openFolder: (path) => {
        setSelectedFolderPath(path);
        setSelectedGuids(new Set());
        setSelectedFolderPaths(new Set());
      },
      openAsset: (asset) => {
        void openOrFocusDocument(asset);
      },
      openFolderMenu: (path, clientX, clientY) => {
        markMenuOpened();
        openFolderMenu(path, clientX, clientY);
      },
      openAssetMenu: (guid, clientX, clientY) => {
        markMenuOpened();
        openTileMenu(guid, clientX, clientY);
      },
      consumeSelectClick,
    };
  });
  const gridActions = useMemo<ContentBrowserGridActions>(
    () => ({
      select: (hit, event) => gridHandlersRef.current?.select(hit, event),
      openFolder: (path) => gridHandlersRef.current?.openFolder(path),
      openAsset: (asset) => gridHandlersRef.current?.openAsset(asset),
      openFolderMenu: (path, clientX, clientY) =>
        gridHandlersRef.current?.openFolderMenu(path, clientX, clientY),
      openAssetMenu: (guid, clientX, clientY) =>
        gridHandlersRef.current?.openAssetMenu(guid, clientX, clientY),
      consumeSelectClick: () =>
        gridHandlersRef.current?.consumeSelectClick() ?? false,
    }),
    [],
  );

  const workspaceRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectionKeys = { enabled: !busy, focusWithinRef: workspaceRef };
  useKeybindCommand("edit.duplicate", () => runSelectionAction("duplicate"), selectionKeys);
  useKeybindCommand("edit.rename", () => runSelectionAction("rename"), selectionKeys);
  useKeybindCommand("edit.delete", () => runSelectionAction("delete"), selectionKeys);
  useKeybindCommand("browser.references", () => runSelectionAction("show-references"), selectionKeys);
  useKeybindCommand("edit.find", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, selectionKeys);
  const creationKeys = { ...selectionKeys, enabled: !busy && selectedRootWritable };
  useKeybindCommand("browser.newAsset", () => openNewAssetMenu(), creationKeys);
  useKeybindCommand("browser.import", () => void handleImport(), creationKeys);
  useKeybindCommand("edit.newFolder", () => {
    setFoldersOpen(false);
    setNameDialog({ kind: "folder", value: "NewFolder" });
  }, creationKeys);

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

  const selectedFolderToOpen =
    selectionCount === 1 ? [...selectedFolderPaths][0] : undefined;
  const selectedAssetToOpen =
    selectionCount === 1 && selectedGuids.size === 1
      ? assetRegistry.getByGuid([...selectedGuids][0]!)
      : undefined;
  const canOpenSelection =
    Boolean(selectedFolderToOpen) ||
    Boolean(
      selectedAssetToOpen &&
        documentKindForAssetType(selectedAssetToOpen.header.type),
    );
  const openSelection = () => {
    if (selectedFolderToOpen) {
      setSelectedFolderPath(selectedFolderToOpen);
      setSelectedGuids(new Set());
      setSelectedFolderPaths(new Set());
      return;
    }
    if (selectedAssetToOpen) void openOrFocusDocument(selectedAssetToOpen);
  };

  const folderNavigation = (
    <ContentBrowserFolderNavigation
      touchSizing={touchSizing}
      keybinds={keybinds}
      busy={busy}
      selectedRootWritable={selectedRootWritable}
      onNewFolder={() => {
        setFoldersOpen(false);
        setNameDialog({ kind: "folder", value: "NewFolder" });
      }}
      browserRows={browserRows}
      assetsByGuid={assetsByGuid}
      browserRoots={browserRoots}
      rootPrefixes={rootPrefixes}
      pluginRootIcons={pluginRootIcons}
      typeVisualFor={typeVisualFor}
      treeSelectedId={treeSelectedId}
      treeSelectedIds={treeSelectedIds}
      onSelect={(id, options) => {
        handleTreeSelect(id, options);
        if (phone) setFoldersOpen(false);
      }}
      onToggleExpanded={toggleFolderExpanded}
      onReparent={handleTreeReparent}
      renamingId={treeRenamingId}
      onRenameRequest={setTreeRenamingId}
      onRenameDone={finishTreeRename}
    />
  );

  return (
    <div
      ref={workspaceRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="content-browser-workspace"
    >
      {operationError && !operationDialog ? (
        <Alert variant="destructive">
          <AlertTitle>Asset Action Failed</AlertTitle>
          <AlertDescription>{operationError}</AlertDescription>
          <Button variant="outline" size="sm" onClick={() => setOperationError(null)}>Dismiss</Button>
        </Alert>
      ) : null}
      <ContentBrowserToolbar
        phone={phone}
        touchSizing={touchSizing}
        phoneIconSize={phoneIconSize}
        hidden={hidden}
        foldersOpen={foldersOpen}
        setFoldersOpen={setFoldersOpen}
        browserRows={browserRows}
        selectedFolderPath={selectedFolderPath}
        folderNavigation={folderNavigation}
        busy={busy}
        selectedRootWritable={selectedRootWritable}
        keybinds={keybinds}
        onImport={handleImport}
        newAssetMenu={newAssetMenuProps}
        search={search}
        setSearch={setSearch}
        searchRef={searchRef}
        typeChips={typeChips}
        typeFilters={typeFilters}
        setTypeFilters={setTypeFilters}
        sortMode={sortMode}
        setSortMode={setSortMode}
        selectionCount={selectionCount}
        onOpenSelection={canOpenSelection ? openSelection : undefined}
        onDeselectAll={() => {
          setSelectedGuids(new Set());
          setSelectedFolderPaths(new Set());
        }}
        onRequestDelete={requestDeleteSelection}
        importInputRef={importInputRef}
        onImportFiles={handleImportInputChange}
      />

      <ResizablePanelGroup
        // A changed pane set remounts the group so panes register in tree order.
        key={phone ? "phone" : "docked"}
        orientation="horizontal"
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          !phone && "content-browser-panes",
        )}
      >
        {!phone ? (
          <>
            <ResizablePanel
              id="content-browser-folders"
              defaultSize="224px"
              minSize="162px"
              className="content-browser-pane"
              style={{ overflow: "hidden" }}
            >
              <aside
                className="flex h-full min-h-0 flex-col gap-1 overflow-hidden bg-sidebar p-2"
                data-testid="content-browser-sidebar"
              >
                {folderNavigation}
              </aside>
            </ResizablePanel>
            <ResizableHandle aria-label="Resize Folders" />
          </>
        ) : null}

        <ResizablePanel
          id="content-browser-assets"
          minSize={phone ? 0 : "240px"}
          className="content-browser-pane flex h-full min-h-0 min-w-0 flex-col"
          style={{ overflow: "hidden" }}
        >
          <ContentBrowserAssetPane
            folderRoot={folderRoot}
            selectedFolderPath={selectedFolderPath}
            touchSizing={touchSizing}
            onNavigate={(path) => {
              setSelectedFolderPath(path);
              setSelectedGuids(new Set());
              setSelectedFolderPaths(new Set());
            }}
            scrollerRef={scrollerRef}
            searchPending={searchPending}
            paintBind={paintBind}
            emptyGridBind={emptyGridBind}
            consumeSelectClick={consumeSelectClick}
            onClearSelection={() => {
              setSelectedGuids(new Set());
              setSelectedFolderPaths(new Set());
            }}
            canOpenSelection={canOpenSelection}
            onOpenSelection={openSelection}
            onOpenNewAssetMenu={openNewAssetMenu}
            onImport={handleImport}
            gridItems={gridItems}
            gridSearch={gridSearch}
            typeFilters={typeFilters}
            onClearFilters={() => {
              setSearch("");
              setTypeFilters([]);
            }}
            selectedRootWritable={selectedRootWritable}
            busy={busy}
            slice={slice}
            spacerHeight={spacerHeight}
            selectedGuids={selectedGuids}
            selectedFolderPaths={selectedFolderPaths}
            thumbnailUrls={thumbnailUrls}
            compileErrorGuids={compileErrorGuids}
            encodingTextures={encodingTextures}
            typeVisualFor={typeVisualFor}
            pluginRootIcons={pluginRootIcons}
            sourceControlEnabled={sourceControl.enabled}
            tileLocks={tileLocks}
            gridActions={gridActions}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      {phone && selectionCount > 0 ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border p-2"
          data-testid="content-browser-phone-selection"
        >
          {canOpenSelection ? (
            <Button
              variant="outline"
              size={touchSizing ? "touch" : "sm"}
              aria-label="Open Selected Item"
              disabled={busy}
              onClick={openSelection}
            >
              <ArrowUpRightIcon data-icon="inline-start" />
              Open
            </Button>
          ) : null}
          <ContentBrowserSelectionActions
            compact
            selectionCount={selectionCount}
            busy={busy}
            onDeselectAll={() => {
              setSelectedGuids(new Set());
              setSelectedFolderPaths(new Set());
            }}
            onRequestDelete={() => requestDeleteSelection()}
          />
        </div>
      ) : null}

      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <ContextMenuOverlay menu={emptyGridMenu} onClose={closeEmptyGridMenu} />

      <ContentBrowserNewAssetDialog {...newAssetDialogProps} />

      <ContentBrowserDeleteDialogs {...deleteDialogProps} />

      <ContentBrowserNameDialog {...nameDialogProps} />

      <ContentBrowserCopyProgressDialog {...copyProgressDialogProps} />

      <ContentBrowserMoveDialog key={moveDialogKey} {...moveDialogProps} />

      {referenceGuid ? (
        <AssetReferenceDialog
          key={referenceGuid}
          rootGuid={referenceGuid}
          assets={referenceAssets}
          openDocuments={openDocuments}
          onClose={() => setReferenceGuid(null)}
          onOpenAsset={(asset) => { void openOrFocusDocument(asset); }}
        />
      ) : null}


      <ImportProgressDialog {...importProgressDialogProps} />

      <AssetPicker
        open={retargetPickerOpen}
        onOpenChange={setRetargetPickerOpen}
        assets={allAssets.map((asset) => ({
          guid: asset.header.guid,
          name: asset.header.name,
          type: asset.header.type,
          path: asset.path,
        }))}
        allowedTypes={["Skeleton"]}
        title="Pick Skeleton"
        allowNone={false}
        onPick={(guid) => {
          void handleRetargetSkeleton(guid);
        }}
        data-testid="content-browser-retarget-picker"
      />

      <ContentBrowserResultDialogs
        retargetErrors={retargetErrors}
        setRetargetErrors={setRetargetErrors}
        importErrors={importErrors}
        setImportErrors={setImportErrors}
        importedFileCount={importedFileCount}
        openError={openError}
        setOpenError={setOpenError}
      />
    </div>
  );
}

/**
 * Skips every render while the browser stays hidden behind another tab: it
 * shows nothing per-edit state can change there. The hide itself still
 * renders (tiles unmount, decode pauses), and showing it renders the current
 * documents, registry, thumbnails, locks and diagnostics. Context updates the
 * body reads itself (search reveals, Play, phone layout) still reach it.
 */
const MemoContentBrowserWorkspaceBody = memo(
  ContentBrowserWorkspaceBody,
  (previous, next) => previous.hidden && next.hidden,
);


export function ContentBrowserWorkspace({
  hidden = false,
}: {
  hidden?: boolean;
} = {}) {
  const actions = useDocumentActions();
  const registry = useRegistryState();
  const { projectDocument } = useProjectState();
  const { thumbnailVersions, thumbnailsEnabled } = useEditorShellState();
  const { sourceControl } = useSourceControl();
  const activeDocumentId = useActiveDocumentId();
  const tabOrder = useTabOrder();
  const { diagnostics } = useValidation();
  return (
    <MemoContentBrowserWorkspaceBody
      hidden={hidden}
      actions={actions}
      registry={registry}
      projectDocument={projectDocument}
      thumbnailVersions={thumbnailVersions}
      thumbnailsEnabled={thumbnailsEnabled}
      sourceControl={sourceControl}
      activeDocumentId={activeDocumentId}
      tabOrder={tabOrder}
      diagnostics={diagnostics}
    />
  );
}