import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { FolderPlusIcon, PlusIcon, UploadIcon } from "lucide-react";
import { useContextMenu, type ContextMenuItem } from "@haptic/editor-kit";
import {
  canRetargetSelectedAssets,
  classDocumentShowsPrefab,
  contentBrowserContextActions,
  isFolderTreeRoot,
} from "../lib/content-browser-helpers";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { contentBrowserTileMenuItems, type ContentBrowserTileMenuDeps } from "./content-browser-tile-menu";

/** What the asset, folder and empty-grid menus and the selection shortcuts read and act through. */
export interface ContentBrowserContextMenusDeps extends ContentBrowserTileMenuDeps {
  selectedRootWritable: boolean;
  classParentOf: (id: string) => string | null;
  selectedGuids: Set<string>;
  selectedFolderPaths: Set<string>;
  setSelectedGuids: Dispatch<SetStateAction<Set<string>>>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  openNewAssetMenu: (anchor?: { x: number; y: number } | null) => void;
  handleImport: () => Promise<void>;
}

/**
 * The asset and folder context menus, the empty-grid menu (right-click or
 * long press), and the selection actions the keyboard shortcuts run.
 */
export function useContentBrowserContextMenus(deps: ContentBrowserContextMenusDeps) {
  const {
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
  } = deps;
  const tileContextItems = useMemo(
    () => contentBrowserTileMenuItems({
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
    }),
    [
      assetRegistry,
      busy,
      projectGuid,
      projectDocument,
      thumbnailsEnabled,
      folderAssetCount,
      runCopySteps,
      openMoveForSnapshot,
      openOrFocusDocument,
      noteAssetsCreated,
      refreshAssetRegistry,
      requestDeleteSnapshot,
      selectedFolderPath,
      browserRoots,
      rootPrefixes,
      setImportErrors,
      updateImportProgress,
      keybinds,
      menuTargetGuidsRef,
      menuTargetFoldersRef,
      importAbortRef,
      setImportProgress,
      setBusy,
      setOperationError,
      setNameDialog,
      setRetargetPickerOpen,
      setReferenceGuid,
    ],
  );

  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: tileContextItems,
  });

  const emptyGridMenuPointRef = useRef<{ x: number; y: number } | null>(null);

  // Disabled like the toolbar buttons, so a read-only root offers no action
  // that would then do nothing.
  const creationDisabled = busy || !selectedRootWritable;
  const emptyGridItems = useMemo(
    () => [
      {
        id: "new-folder",
        label: "New Folder",
        shortcut: keybinds.get("edit.newFolder")?.[0],
        icon: <FolderPlusIcon />,
        disabled: creationDisabled,
        onSelect: () => setNameDialog({ kind: "folder", value: "NewFolder" }),
      },
      {
        id: "new-asset",
        label: "New Asset",
        shortcut: keybinds.get("browser.newAsset")?.[0],
        icon: <PlusIcon />,
        disabled: creationDisabled,
        onSelect: () => openNewAssetMenu(emptyGridMenuPointRef.current),
      },
      {
        id: "import",
        label: "Import",
        shortcut: keybinds.get("browser.import")?.[0],
        icon: <UploadIcon />,
        disabled: creationDisabled,
        onSelect: () => {
          void handleImport();
        },
      },
    ],
    [creationDisabled, handleImport, openNewAssetMenu, keybinds, setNameDialog],
  );
  const {
    menu: emptyGridMenu,
    closeMenu: closeEmptyGridMenu,
    openMenuAt: openEmptyGridMenuAt,
  } = useContextMenu({ items: emptyGridItems });
  const emptyGridBind = useLongPressMenu({
    onMenu: (clientX, clientY) => {
      closeMenu();
      emptyGridMenuPointRef.current = { x: clientX, y: clientY };
      openEmptyGridMenuAt(clientX, clientY);
    },
  });

  const selectionActionIds = useCallback(
    (guids: string[], folders: string[]) =>
      new Set<string>(
        contentBrowserContextActions({
          assetCount: guids.length,
          folderCount: folders.length,
          canGenerateThumbnails: Boolean(projectGuid && thumbnailsEnabled) && guids.every((guid) => {
            const asset = assetRegistry?.getByGuid(guid);
            if (!asset) return false;
            const type = asset.header.type;
            return type === "Model" || type === "Animation" || type === "Material" ||
              (type === "Class" && classDocumentShowsPrefab(asset.header.parentClass, classParentOf));
          }),
          singleAssetType:
            guids.length === 1 && folders.length === 0
              ? assetRegistry?.getByGuid(guids[0]!)?.header.type
              : undefined,
          canRetarget: canRetargetSelectedAssets(
            guids.flatMap((guid) => {
              const asset = assetRegistry?.getByGuid(guid);
              if (!asset) return [];
              return [{ type: asset.header.type, payload: asset.header.payload }];
            }),
          ),
        }),
      ),
    [assetRegistry, classParentOf, projectGuid, thumbnailsEnabled],
  );

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
        guids = [extra.guid];
        folders = [];
        setSelectedGuids(new Set(guids));
        setSelectedFolderPaths(new Set());
      }
      if (extra.folderPath && !folders.includes(extra.folderPath)) {
        guids = [];
        folders = [extra.folderPath];
        setSelectedGuids(new Set());
        setSelectedFolderPaths(new Set(folders));
      }
      menuTargetGuidsRef.current = guids;
      menuTargetFoldersRef.current = folders;
      const actionIds = selectionActionIds(guids, folders);
      const items: ContextMenuItem[] = tileContextItems.filter((item) =>
        actionIds.has(item.id),
      ).map((item) => item.id === "generate-thumbnail"
        ? { ...item, label: guids.length === 1 ? "Generate Thumbnail" : "Generate Thumbnails" }
        : item);
      const deleteIndex = items.findIndex((item) => item.id === "delete");
      if (deleteIndex > 0)
        items.splice(deleteIndex, 0, { type: "separator", id: "delete-separator" });
      openMenuAt(clientX, clientY, items);
    },
    [
      closeEmptyGridMenu,
      openMenuAt,
      rootPrefixes,
      selectedFolderPaths,
      selectedGuids,
      tileContextItems,
      selectionActionIds,
      menuTargetGuidsRef,
      menuTargetFoldersRef,
      setSelectedGuids,
      setSelectedFolderPaths,
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

  const runSelectionAction = (actionId: "duplicate" | "rename" | "delete" | "show-references") => {
    const guids = [...selectedGuids];
    const folders = [...selectedFolderPaths].filter(
      (path) => !isFolderTreeRoot(path, rootPrefixes),
    );
    if (guids.length + folders.length === 0) return;
    if (!selectionActionIds(guids, folders).has(actionId)) return;
    menuTargetGuidsRef.current = guids;
    menuTargetFoldersRef.current = folders;
    tileContextItems.find((item) => item.id === actionId)?.onSelect();
  };

  return {
    menu,
    closeMenu,
    emptyGridMenu,
    closeEmptyGridMenu,
    emptyGridBind,
    openTileMenu,
    openFolderMenu,
    runSelectionAction,
  };
}
