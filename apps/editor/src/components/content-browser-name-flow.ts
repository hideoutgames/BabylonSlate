import {
  useCallback,
  useState,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  contentEntryNameError,
  renamedAssetPath,
  stripAssetFileSuffix,
  type AssetRegistry,
  type IndexedAsset,
} from "@haptic/assets";
import type { useDocumentActions, useSourceControl } from "../context/document-context";
import { applyLockTransfers } from "../lib/source-control-file-ops";
import {
  classIdConflict,
  isFolderNameTaken,
  isRenameNameTaken,
  joinAssetFolderPath,
  parentFolderPath,
  remapPathAfterFolderMove,
  type ContentBrowserTreeRow,
} from "../lib/content-browser-helpers";
import { primeSoftKeyboard } from "@haptic/editor-kit";
import { contentBrowserFolderOps, type ContentBrowserRoot } from "../lib/plugin-ui";
import type { ContentBrowserGridItem, ContentBrowserTileHit } from "./content-browser-grid-tiles";
import type { ContentBrowserNameDialog, NameEntry } from "./content-browser-name-dialog";
import { remapFolderSelection } from "./content-browser-move-flow";

/** Starting name of a folder New Folder creates before it is renamed inline. */
export const NEW_FOLDER_NAME = "NewFolder";

/** Where a new folder's inline rename opens: its grid tile or its tree row. */
export type NewFolderPlace = "grid" | "tree";

/** What New Folder and Rename read from the Content Browser and act through. */
export interface ContentBrowserNameFlowDeps extends Pick<
  ReturnType<typeof useDocumentActions>,
  "noteAssetsCreated" | "refreshAssetRegistry" | "renameAsset" | "repathProjectFolder"
> {
  /** Owned by the workspace, which also reads it to tell which operation dialog is open. */
  nameDialog: NameEntry | null;
  setNameDialog: Dispatch<SetStateAction<NameEntry | null>>;
  assetRegistry: AssetRegistry | null;
  allAssets: IndexedAsset[];
  referenceAssets: IndexedAsset[];
  existingAssetPaths: string[];
  existingFolderPaths: string[];
  browserRows: ContentBrowserTreeRow[];
  browserRoots: ContentBrowserRoot[];
  /** The open folder's tiles; Rename edits a listed tile in place. */
  gridItems: readonly ContentBrowserGridItem[];
  selectedFolderPath: string;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  setSelectedGuids: Dispatch<SetStateAction<Set<string>>>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  /** The open folder's content root and path, where New Folder writes. */
  selectedRoot: ReturnType<typeof contentBrowserFolderOps>;
  /** Expands the tree down to a folder so its row shows. */
  revealFolder: (path: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  operationError: string | null;
  setOperationError: (error: string | null) => void;
  refuseTheirsAssetPaths: (paths: string[]) => boolean;
  repairDocumentPath: (oldPath: string, newPath: string, type: string) => void;
  transferFolderLocks: (fromPath: string, nextFolder: string) => Promise<void>;
  sourceControl: ReturnType<typeof useSourceControl>["sourceControl"];
}

function isGridItem(items: readonly ContentBrowserGridItem[], target: ContentBrowserTileHit): boolean {
  return items.some((item) =>
    target.kind === "folder"
      ? item.kind === "folder" && item.path === target.path
      : item.kind === "asset" && item.asset.header.guid === target.guid,
  );
}

/**
 * New Folder (created as `NewFolder`, then renamed inline in its grid tile or
 * tree row), and Rename inline in a grid tile or tree row. The name dialog
 * takes a refused name, or a Rename whose tile the open folder does not list.
 */
export function useContentBrowserNameFlow(deps: ContentBrowserNameFlowDeps) {
  const {
    nameDialog,
    setNameDialog,
    assetRegistry,
    allAssets,
    referenceAssets,
    existingAssetPaths,
    existingFolderPaths,
    browserRows,
    browserRoots,
    gridItems,
    selectedFolderPath,
    setSelectedFolderPath,
    setSelectedGuids,
    setSelectedFolderPaths,
    selectedRoot,
    revealFolder,
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
  } = deps;
  const [treeRenamingId, setTreeRenamingId] = useState<string | null>(null);
  /** A folder or asset in the open folder `parent`, renamed inline in its grid tile. */
  const [gridRenaming, setGridRenaming] = useState<{ target: ContentBrowserTileHit; parent: string } | null>(null);
  // Leaving the folder ends the rename; the item keeps its name.
  const gridRenamingTarget = gridRenaming?.parent === selectedFolderPath ? gridRenaming.target : null;

  const nameEntryError = (entry: NameEntry): string | null => {
    const invalid = contentEntryNameError(entry.value);
    if (invalid) return invalid;
    if (entry.kind === "rename") {
      const asset = assetRegistry?.getByGuid(entry.guid);
      if (!asset) return null;
      if (isRenameNameTaken(existingAssetPaths, asset.path, entry.value)) {
        return "That name is already used in this folder.";
      }
      const next = renamedAssetPath(asset.path, entry.value);
      return asset.header.type === "Class" && next !== asset.path
        ? classIdConflict(referenceAssets, next, asset.path)
        : null;
    }
    const parent = parentFolderPath(entry.path);
    const next = joinAssetFolderPath(parent, entry.value.trim());
    return next !== entry.path && isFolderNameTaken(existingFolderPaths, parent, entry.value)
      ? "That name is already used in this folder."
      : null;
  };
  const nameDialogError = nameDialog ? nameEntryError(nameDialog) : null;

  const submitNameEntry = useCallback(async (nameDialog: NameEntry) => {
    if (!assetRegistry || busy) return;
    setOperationError(null);
    setBusy(true);
    try {
      if (nameDialog.kind === "rename-folder") {
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
        repathProjectFolder(fromPath, nextFolder);
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
        setSelectedFolderPaths((current) => remapFolderSelection(current, fromPath, nextFolder));
        await refreshAssetRegistry();
        setNameDialog(null);
        await transferFolderLocks(fromPath, nextFolder);
      } else if (nameDialog.kind === "rename") {
        const before = assetRegistry.getByGuid(nameDialog.guid);
        if (!before) return;
        if (refuseTheirsAssetPaths([before.path])) return;
        const renamed = await renameAsset(
          nameDialog.guid,
          nameDialog.value.trim(),
        );
        repairDocumentPath(before.path, renamed.path, renamed.header.type);
        await refreshAssetRegistry();
        setNameDialog(null);
        await applyLockTransfers(
          [{ from: before.path, to: renamed.path }],
          (path) => sourceControl.lockStateForPath(path),
          (from, to) => sourceControl.transferLock(from, to),
        );
      }
      setNameDialog(null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    assetRegistry,
    busy,
    renameAsset,
    allAssets,
    refreshAssetRegistry,
    refuseTheirsAssetPaths,
    repairDocumentPath,
    repathProjectFolder,
    browserRoots,
    sourceControl,
    transferFolderLocks,
    setBusy,
    setNameDialog,
    setOperationError,
    setSelectedFolderPath,
    setSelectedFolderPaths,
  ]);

  const confirmNameDialog = () => {
    if (!nameDialog || nameDialogError) return Promise.resolve();
    return submitNameEntry(nameDialog);
  };

  /**
   * Creates a free `NewFolder` (`NewFolder_1`, …) in the open folder, selects
   * it and opens its inline rename, like a new Class function.
   */
  const createFolder = useCallback(async (place: NewFolderPlace) => {
    if (!assetRegistry || busy || selectedRoot.readOnly) return;
    // The name field focuses after the write, outside this tap: hold the
    // on-screen keyboard open until it does.
    primeSoftKeyboard();
    let name = NEW_FOLDER_NAME;
    for (let index = 1; isFolderNameTaken(existingFolderPaths, selectedFolderPath, name); index += 1) {
      name = `${NEW_FOLDER_NAME}_${index}`;
    }
    const relative = selectedRoot.relative ? `${selectedRoot.relative}/${name}` : name;
    const path = `${selectedRoot.pathPrefix}/${relative}`;
    setOperationError(null);
    setBusy(true);
    try {
      await assetRegistry.createFolder(selectedRoot.rootId, relative);
      // The mounted registry recorded the folder on write: no rescan.
      noteAssetsCreated();
      setSelectedGuids(new Set());
      setSelectedFolderPaths(new Set([path]));
      if (place === "tree") {
        revealFolder(path);
        setTreeRenamingId(path);
      } else {
        setGridRenaming({ target: { kind: "folder", path }, parent: selectedFolderPath });
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    assetRegistry,
    busy,
    existingFolderPaths,
    noteAssetsCreated,
    revealFolder,
    selectedFolderPath,
    selectedRoot,
    setBusy,
    setOperationError,
    setSelectedFolderPaths,
    setSelectedGuids,
  ]);

  /** Inline renames commit directly; an invalid name reopens in the dialog with its error. */
  const commitInlineRename = (entry: NameEntry) => {
    if (nameEntryError(entry)) setNameDialog(entry);
    else void submitNameEntry(entry);
  };

  const finishTreeRename = (id: string, name: string | null) => {
    setTreeRenamingId(null);
    if (name === null || !assetRegistry) return;
    const row = browserRows.find((item) => item.id === id);
    if (!row) return;
    if (row.kind === "folder") commitInlineRename({ kind: "rename-folder", path: row.path, value: name });
    else if (row.guid) commitInlineRename({ kind: "rename", guid: row.guid, value: name });
  };

  /**
   * Rename from a menu or the shortcut: inline in the item's grid tile, like a
   * new folder, or in the name dialog when the open folder does not list it.
   */
  const startRename = useCallback((target: ContentBrowserTileHit) => {
    if (isGridItem(gridItems, target)) {
      setGridRenaming({ target, parent: selectedFolderPath });
      return;
    }
    if (target.kind === "folder") {
      setNameDialog({ kind: "rename-folder", path: target.path, value: target.path.slice(target.path.lastIndexOf("/") + 1) });
      return;
    }
    const asset = assetRegistry?.getByGuid(target.guid);
    if (!asset) return;
    setNameDialog({
      kind: "rename",
      guid: target.guid,
      value: stripAssetFileSuffix(asset.path.split("/").at(-1) ?? asset.header.name),
    });
  }, [assetRegistry, gridItems, selectedFolderPath, setNameDialog]);

  /** Cancelling or keeping the text leaves the name as it was. */
  const finishGridRename = (target: ContentBrowserTileHit, name: string | null) => {
    setGridRenaming(null);
    if (name === null || !assetRegistry) return;
    commitInlineRename(
      target.kind === "folder"
        ? { kind: "rename-folder", path: target.path, value: name }
        : { kind: "rename", guid: target.guid, value: name },
    );
  };

  const dialogProps: ComponentProps<typeof ContentBrowserNameDialog> = {
    nameDialog,
    setNameDialog,
    nameDialogError,
    operationError,
    busy,
    confirmNameDialog,
  };

  return {
    createFolder,
    treeRenamingId,
    setTreeRenamingId,
    finishTreeRename,
    startRename,
    gridRenamingTarget,
    finishGridRename,
    dialogProps,
  };
}
