import { isThumbnailableAssetType } from "@haptic/assets";
import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { FolderPlusIcon, Grid2x2Icon, PlusIcon, UploadIcon } from "lucide-react";
import { useContextMenu, useContextMenuGesture, type ContextMenuItem } from "@haptic/editor-kit";
import {
  canRetargetSelectedAssets,
  classDocumentShowsPrefab,
  classIdFromClassAsset,
  contentBrowserContextActions,
  CONVERT_TO_2D_ACTIONS,
  isFolderTreeRoot,
} from "../lib/content-browser-helpers";
import { isNewClassParentAllowed } from "../lib/create-project-asset";
import { contentBrowserTileMenuItems, type ContentBrowserTileMenuDeps } from "./content-browser-tile-menu";
import { useExtensionMenuItems } from "./use-extension-menu-items";

/** What the asset, folder and empty-grid menus and the selection shortcuts read and act through. */
export interface ContentBrowserContextMenusDeps extends ContentBrowserTileMenuDeps {
  selectedRootWritable: boolean;
  selectedGuids: Set<string>;
  selectedFolderPaths: Set<string>;
  setSelectedGuids: Dispatch<SetStateAction<Set<string>>>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  openNewAssetMenu: (anchor?: { x: number; y: number } | null) => void;
  /** Creates a folder in the open folder and renames it inline in the grid. */
  onNewFolder: () => void;
  handleImport: () => Promise<void>;
}

/**
 * The asset and folder context menus, the empty-grid menu (right-click or
 * long press), and the selection actions the keyboard shortcuts run.
 */
/**
 * Convert to 2D, for Textures alone: a Sprite per Texture, one Sprite Animation with a frame per Texture (in name
 * order), and a Sheet Sprite Animation per Texture.
 */
function convertTo2DSubmenu(items: readonly ContextMenuItem[], count: number): ContextMenuItem {
  const labels: Record<(typeof CONVERT_TO_2D_ACTIONS)[number], string> = {
    "create-sprite": count > 1 ? "Create Sprites" : "Create Sprite",
    "create-sprite-animation": "Create Animation",
    "create-sheet-animation": count > 1 ? "Create Sheet Animations" : "Create Sheet Animation",
  };
  return {
    type: "submenu",
    id: "convert-to-2d",
    label: "Convert to 2D",
    icon: <Grid2x2Icon />,
    items: CONVERT_TO_2D_ACTIONS.flatMap((id) => {
      const item = items.find((entry) => entry.id === id);
      return item && item.type !== "submenu" && item.type !== "separator" && item.type !== "checkbox" ? [{ ...item, label: labels[id] }] : [];
    }),
  };
}

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
    startRename,
    setRetargetPickerOpen,
    openMoveForSnapshot,
    setReferenceGuid,
    requestDeleteSnapshot,
    selectedRootWritable,
    classParentOf,
    getOpenDocuments,
    selectedGuids,
    selectedFolderPaths,
    setSelectedGuids,
    setSelectedFolderPaths,
    openNewAssetMenu,
    onNewFolder,
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
      startRename,
      setRetargetPickerOpen,
      openMoveForSnapshot,
      setReferenceGuid,
      requestDeleteSnapshot,
      classParentOf,
      getOpenDocuments,
    }),
    [
      classParentOf,
      getOpenDocuments,
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
      startRename,
      setRetargetPickerOpen,
      setReferenceGuid,
    ],
  );

  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: tileContextItems,
  });

  const emptyGridMenuPointRef = useRef<{ x: number; y: number } | null>(null);

  // Extension entries read what the menu was opened on when they run.
  const assetExtensionItems = useExtensionMenuItems("contentBrowser.asset", useCallback(() => ({
    assets: menuTargetGuidsRef.current.flatMap((guid) => {
      const asset = assetRegistry?.getByGuid(guid);
      return asset ? [{ path: asset.path, type: asset.header.type, name: asset.header.name, guid }] : [];
    }),
  }), [assetRegistry, menuTargetGuidsRef]));
  const folderExtensionItems = useExtensionMenuItems("contentBrowser.folder", useCallback(() => ({
    folders: [...menuTargetFoldersRef.current],
  }), [menuTargetFoldersRef]));
  const emptyExtensionItems = useExtensionMenuItems("contentBrowser.empty", useCallback(() => ({
    folder: selectedFolderPath,
  }), [selectedFolderPath]));

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
        onSelect: onNewFolder,
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
      ...emptyExtensionItems,
    ],
    [creationDisabled, emptyExtensionItems, handleImport, openNewAssetMenu, onNewFolder, keybinds],
  );
  const {
    menu: emptyGridMenu,
    closeMenu: closeEmptyGridMenu,
    openMenuAt: openEmptyGridMenuAt,
  } = useContextMenu({ items: emptyGridItems });
  const emptyGridBind = useContextMenuGesture({
    exclusive: true,
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
            return type === "Class"
              ? classDocumentShowsPrefab(asset.header.parentClass, classParentOf)
              : isThumbnailableAssetType(type);
          }),
          singleAssetType:
            guids.length === 1 && folders.length === 0
              ? assetRegistry?.getByGuid(guids[0]!)?.header.type
              : undefined,
          assetTypes: guids.flatMap((guid) => {
            const type = assetRegistry?.getByGuid(guid)?.header.type;
            return type ? [type] : [];
          }),
          canCreateChildClass: (() => {
            const asset = guids.length === 1 ? assetRegistry?.getByGuid(guids[0]!) : undefined;
            return asset?.header.type === "Class" && isNewClassParentAllowed(classIdFromClassAsset(asset), assetRegistry?.list() ?? []);
          })(),
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
      const items: ContextMenuItem[] = [];
      for (const item of tileContextItems) {
        // Textures alone gather their 2D conversions in one submenu, where the first of them would stand.
        if (item.id === CONVERT_TO_2D_ACTIONS[0] && actionIds.has("convert-to-2d")) {
          items.push(convertTo2DSubmenu(tileContextItems, guids.length));
          continue;
        }
        if (!actionIds.has(item.id)) continue;
        if (item.id === "generate-thumbnail") items.push({ ...item, label: guids.length === 1 ? "Generate Thumbnail" : "Generate Thumbnails" });
        else items.push(item);
      }
      const deleteIndex = items.findIndex((item) => item.id === "delete");
      if (deleteIndex > 0)
        items.splice(deleteIndex, 0, { type: "separator", id: "delete-separator" });
      // Extension entries apply to a selection of only assets or only folders.
      if (guids.length > 0 && folders.length === 0) items.push(...assetExtensionItems);
      if (folders.length > 0 && guids.length === 0) items.push(...folderExtensionItems);
      openMenuAt(clientX, clientY, items);
    },
    [
      assetExtensionItems,
      folderExtensionItems,
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
