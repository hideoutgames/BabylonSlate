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
import { contentBrowserFolderOps, type ContentBrowserRoot } from "../lib/plugin-ui";
import type { ContentBrowserNameDialog, NameEntry } from "./content-browser-name-dialog";
import { remapFolderSelection } from "./content-browser-move-flow";

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
  selectedFolderPath: string;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  /** The open folder's content root and path, where New Folder writes. */
  selectedRoot: ReturnType<typeof contentBrowserFolderOps>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  operationError: string | null;
  setOperationError: (error: string | null) => void;
  refuseTheirsAssetPaths: (paths: string[]) => boolean;
  repairDocumentPath: (oldPath: string, newPath: string, type: string) => void;
  transferFolderLocks: (fromPath: string, nextFolder: string) => Promise<void>;
  sourceControl: ReturnType<typeof useSourceControl>["sourceControl"];
}

/** New Folder, Rename and Rename Folder, from the name dialog or an inline tree rename. */
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
  } = deps;
  const [treeRenamingId, setTreeRenamingId] = useState<string | null>(null);

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
    const taken =
      entry.kind === "folder"
        ? isFolderNameTaken(existingFolderPaths, selectedFolderPath, entry.value)
        : (() => {
            const parent = parentFolderPath(entry.path);
            const next = joinAssetFolderPath(parent, entry.value.trim());
            if (next === entry.path) return false;
            return isFolderNameTaken(existingFolderPaths, parent, entry.value);
          })();
    return taken ? "That name is already used in this folder." : null;
  };
  const nameDialogError = nameDialog ? nameEntryError(nameDialog) : null;

  const submitNameEntry = useCallback(async (nameDialog: NameEntry) => {
    if (!assetRegistry || busy) return;
    setOperationError(null);
    setBusy(true);
    try {
      if (nameDialog.kind === "folder") {
        if (selectedRoot.readOnly) return;
        const relative = selectedRoot.relative
          ? `${selectedRoot.relative}/${nameDialog.value.trim()}`
          : nameDialog.value.trim();
        if (!relative) return;
        await assetRegistry.createFolder(selectedRoot.rootId, relative);
        // The mounted registry recorded the folder on write: no rescan.
        noteAssetsCreated();
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
    noteAssetsCreated,
    refreshAssetRegistry,
    refuseTheirsAssetPaths,
    repairDocumentPath,
    repathProjectFolder,
    selectedFolderPath,
    selectedRoot,
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

  /** Inline tree renames commit directly; an invalid name reopens in the dialog with its error. */
  const finishTreeRename = (id: string, name: string | null) => {
    setTreeRenamingId(null);
    if (name === null || !assetRegistry) return;
    const row = browserRows.find((item) => item.id === id);
    if (!row) return;
    const entry: NameEntry | null =
      row.kind === "folder"
        ? { kind: "rename-folder", path: row.path, value: name }
        : row.guid
          ? { kind: "rename", guid: row.guid, value: name }
          : null;
    if (!entry) return;
    if (nameEntryError(entry)) setNameDialog(entry);
    else void submitNameEntry(entry);
  };

  const dialogProps: ComponentProps<typeof ContentBrowserNameDialog> = {
    nameDialog,
    setNameDialog,
    nameDialogError,
    selectedFolderPath,
    operationError,
    busy,
    confirmNameDialog,
  };

  return { treeRenamingId, setTreeRenamingId, finishTreeRename, dialogProps };
}
