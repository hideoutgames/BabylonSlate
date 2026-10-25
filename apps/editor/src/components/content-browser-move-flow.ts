import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { AssetRegistry, FolderNode, IndexedAsset } from "@haptic/assets";
import type { TreeDropPlacement, TypeVisual } from "@haptic/editor-kit";
import type {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useSourceControl,
} from "../context/document-context";
import { applyLockTransfers, containedAssetPaths } from "../lib/source-control-file-ops";
import {
  ASSETS_ROOT,
  contentBrowserMovePreviewName,
  contentBrowserSelectionMoves,
  contentBrowserTreeDropMoves,
  guidsOutsideSelectedFolders,
  isCrossRootMove,
  isFolderTreeRoot,
  moveNameCollision,
  parentFolderPath,
  remapPathAfterFolderMove,
  rootSelectedFolderPaths,
  visualForIndexedAsset,
  type ContentBrowserDropMove,
  type ContentBrowserTreeRow,
} from "../lib/content-browser-helpers";
import { contentBrowserFolderOps, contentRootMoveWarnings, type ContentBrowserRoot } from "../lib/plugin-ui";
import type {
  ContentBrowserCopyProgress,
  ContentBrowserCopyProgressDialogProps,
} from "./content-browser-copy-progress-dialog";
import type { ContentBrowserMoveDialogProps } from "./content-browser-move-dialog";
import type { CopyStep } from "./content-browser-tile-menu";

export type MoveTarget = {
  operation: "move" | "copy";
  kind: "asset" | "folder";
  guids: string[];
  folderPaths: string[];
  name: string;
  sourcePath: string;
  folderPath: string;
  /** Asset files of `guids`, in order. */
  assetPaths: string[];
  itemCount: number;
  typeVisual: TypeVisual | null;
};

const NO_PATHS: readonly string[] = [];

/** Folder selection after `fromFolder` moved to `toFolder`; an unchanged set is kept. */
export function remapFolderSelection(
  selected: Set<string>,
  fromFolder: string,
  toFolder: string,
): Set<string> {
  const next = new Set([...selected].map((path) => remapPathAfterFolderMove(path, fromFolder, toFolder)));
  return next.size === selected.size && [...next].every((path) => selected.has(path)) ? selected : next;
}

/** What Move…, Copy to Folder…, the copy runner and folder tree drops read and act through. */
export interface ContentBrowserMoveFlowDeps extends Pick<
  ReturnType<typeof useDocumentActions>,
  "repathProjectFolder" | "refreshAssetRegistry"
> {
  /** Owned by the workspace, which also reads it to tell which operation dialog is open. */
  moveTarget: MoveTarget | null;
  setMoveTarget: Dispatch<SetStateAction<MoveTarget | null>>;
  assetRegistry: AssetRegistry | null;
  allAssets: IndexedAsset[];
  folderTrees: FolderNode[];
  browserRows: ContentBrowserTreeRow[];
  browserRoots: ContentBrowserRoot[];
  rootPrefixes: string[];
  readOnlyRootPrefixes: string[];
  existingContentPaths: Set<string>;
  classParentOf: (id: string) => string | null;
  pluginDescriptors: ReturnType<typeof useRegistryState>["pluginDescriptors"];
  projectDocument: ReturnType<typeof useProjectState>["projectDocument"];
  selectedFolderPath: string;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  selectedGuids: Set<string>;
  selectedFolderPaths: Set<string>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  /** The assets and folders the open context menu acts on. */
  menuTargetGuidsRef: RefObject<string[]>;
  menuTargetFoldersRef: RefObject<string[]>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  operationError: string | null;
  setOperationError: (error: string | null) => void;
  refuseTheirsAssetPaths: (paths: string[]) => boolean;
  repairDocumentPath: (oldPath: string, newPath: string, type: string) => void;
  transferFolderLocks: (fromPath: string, nextFolder: string) => Promise<void>;
  sourceControl: ReturnType<typeof useSourceControl>["sourceControl"];
}

/**
 * Move… and Copy to Folder… with their dialog, the cancelable copy runner
 * Duplicate shares, and moves dropped on the folder tree.
 */
export function useContentBrowserMoveFlow(deps: ContentBrowserMoveFlowDeps) {
  const {
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
  } = deps;
  const [copyProgress, setCopyProgress] = useState<ContentBrowserCopyProgress | null>(null);
  const copyAbortRef = useRef<AbortController | null>(null);

  /**
   * Runs Copy to Folder or Duplicate behind the cancelable progress dialog.
   * Cancel aborts the copy in progress and deletes the copies already made, so
   * a canceled operation leaves the content as it was. Returns false then.
   */
  const runCopySteps = useCallback(async (
    operation: ContentBrowserCopyProgress["operation"],
    steps: readonly CopyStep[],
  ): Promise<boolean> => {
    const controller = new AbortController();
    copyAbortRef.current = controller;
    const total = steps.reduce((sum, step) => sum + step.units, 0);
    const undo: Array<() => Promise<void>> = [];
    let completed = 0;
    setCopyProgress({ operation, name: steps[0]?.name ?? "", completed, total, canceling: false });
    try {
      for (const step of steps) {
        controller.signal.throwIfAborted();
        const base = completed;
        setCopyProgress((current) => current && { ...current, name: step.name, completed: base });
        undo.push(await step.run({
          signal: controller.signal,
          onProgress: (copied) => setCopyProgress((current) => current && { ...current, completed: base + copied }),
        }));
        completed = base + step.units;
        setCopyProgress((current) => current && { ...current, completed });
        step.onDone?.();
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      for (const revert of undo.reverse()) await revert();
      return false;
    } finally {
      copyAbortRef.current = null;
      setCopyProgress(null);
    }
  }, []);

  const cancelCopy = useCallback(() => {
    copyAbortRef.current?.abort();
    setCopyProgress((current) => current && { ...current, canceling: true });
  }, []);

  /** Files a folder copy writes, for the progress total. */
  const folderAssetCount = useCallback((path: string) =>
    assetRegistry?.list().filter((asset) => asset.path.startsWith(`${path}/`)).length ?? 0,
  [assetRegistry]);

  /** Open Move… / Copy to Folder… for outermost folders and the assets outside them. */
  const openMoveDialog = useCallback(
    (operation: "move" | "copy", folders: string[], guids: string[], destinationPath?: string) => {
      if (!assetRegistry || folders.length + guids.length === 0) return;
      const names: string[] = [];
      const assetPaths: string[] = [];
      for (const path of folders) {
        names.push(path.slice(path.lastIndexOf("/") + 1));
      }
      let typeVisual: TypeVisual | null = null;
      for (const guid of guids) {
        const asset = assetRegistry.getByGuid(guid);
        if (!asset) continue;
        names.push(asset.header.name);
        assetPaths.push(asset.path);
        if (guids.length === 1 && folders.length === 0) {
          typeVisual = visualForIndexedAsset(asset, classParentOf);
        }
      }
      const sourcePath =
        folders[0] ?? (assetPaths[0] ? parentFolderPath(assetPaths[0]) : selectedFolderPath);
      setMoveTarget({
        operation,
        kind: folders.length > 0 && guids.length === 0 ? "folder" : "asset",
        guids,
        folderPaths: folders,
        name: contentBrowserMovePreviewName(names),
        sourcePath,
        folderPath: destinationPath ?? sourcePath,
        assetPaths,
        itemCount: folders.length + guids.length,
        typeVisual,
      });
    },
    [assetRegistry, classParentOf, selectedFolderPath, setMoveTarget],
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
      openMoveDialog(operation, folders, guids);
    },
    [assetRegistry, menuTargetFoldersRef, menuTargetGuidsRef, openMoveDialog, rootPrefixes],
  );

  /**
   * How `moves` into `destinationPath` change plugin behaviour (see
   * `contentRootMoveWarnings`); empty when every item stays in its root.
   */
  const crossRootMoveWarnings = useCallback(
    (moves: readonly ContentBrowserDropMove[], destinationPath: string): string[] => {
      if (!assetRegistry) return [];
      const crossing = moves.filter((move) => isCrossRootMove(move.id, destinationPath, rootPrefixes));
      if (crossing.length === 0) return [];
      const assets = assetRegistry.list();
      const movedGuids = crossing.flatMap((move) => move.kind === "folder"
        ? assets.filter((asset) => asset.path.startsWith(`${move.sourcePath}/`)).map((asset) => asset.header.guid)
        : move.guid ? [move.guid] : []);
      return contentRootMoveWarnings({
        movedGuids,
        targetRootId: contentBrowserFolderOps(destinationPath, browserRoots).rootId,
        assets,
        showReferences: (guid) => assetRegistry.showReferences(guid),
        plugins: pluginDescriptors.map((plugin) => ({
          pluginGuid: plugin.pluginGuid,
          displayName: plugin.settings.displayName,
          enabledByDefault: plugin.settings.enabledByDefault,
          dependencyGuids: plugin.settings.pluginDependencies.map((dependency) => dependency.guid),
        })),
        projectPluginOverrides: projectDocument?.settings.pluginOverrides,
        exportPresets: projectDocument?.settings.exportPresets,
      });
    },
    [assetRegistry, browserRoots, pluginDescriptors, projectDocument, rootPrefixes],
  );

  const applyRegistryMoves = useCallback(
    async (moves: ContentBrowserDropMove[], onMoved?: (move: ContentBrowserDropMove) => void) => {
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
          if (from.readOnly) continue;
          const folderName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
          const nextFolder = `${destPath}/${folderName}`;
          const contained = allAssets.filter(
            (asset) =>
              asset.path === fromPath ||
              asset.path.startsWith(`${fromPath}/`),
          );
          if (from.rootId === dest.rootId) {
            await assetRegistry.moveFolder(from.rootId, from.relative, destRelative);
          } else {
            await assetRegistry.moveFolder(from.rootId, from.relative, destRelative, undefined, dest.rootId);
          }
          repathProjectFolder(fromPath, nextFolder);
          onMoved?.(move);
          setSelectedFolderPaths((current) => remapFolderSelection(current, fromPath, nextFolder));
          for (const asset of contained) {
            repairDocumentPath(
              asset.path,
              remapPathAfterFolderMove(asset.path, fromPath, nextFolder),
              asset.header.type,
            );
          }
          setSelectedFolderPath(nextFolder);
          await transferFolderLocks(fromPath, nextFolder);
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
          onMoved?.(move);
          repairDocumentPath(before.path, moved.path, moved.header.type);
          setSelectedFolderPath(destPath);
          await applyLockTransfers(
            [{ from: before.path, to: moved.path }],
            (path) => sourceControl.lockStateForPath(path),
            (from, to) => sourceControl.transferLock(from, to),
          );
        }
      }
    },
    [
      allAssets,
      assetRegistry,
      browserRoots,
      refuseTheirsAssetPaths,
      repairDocumentPath,
      repathProjectFolder,
      setSelectedFolderPath,
      setSelectedFolderPaths,
      sourceControl,
      transferFolderLocks,
    ],
  );

  /**
   * The moves of a Move… / Copy to Folder… at its chosen destination, under
   * the tree drop's rules: items that cannot change root (read-only content,
   * or any other root for a Copy) and, for Move, items already in the
   * destination stay where they are.
   */
  const planMoveTarget = useCallback((target: MoveTarget) => {
    const guidByPath = new Map(target.guids.flatMap((guid) => {
      const path = assetRegistry?.getByGuid(guid)?.path;
      return path ? [[path, guid] as const] : [];
    }));
    const plan = contentBrowserSelectionMoves({
      destinationPath: target.folderPath,
      operation: target.operation,
      assetPaths: [...guidByPath.keys()],
      folderPaths: target.folderPaths,
      rootPaths: rootPrefixes,
      readOnlyRootPaths: readOnlyRootPrefixes,
      existingPaths: existingContentPaths,
    });
    return {
      error: plan.error,
      moves: plan.moves.map((move) =>
        move.kind === "asset" ? { ...move, guid: guidByPath.get(move.id) } : move),
    };
  }, [assetRegistry, existingContentPaths, readOnlyRootPrefixes, rootPrefixes]);

  /** The source's root, plus for a Move every writable root it may go to. */
  const moveFolderTrees = useMemo(() => {
    const sourcePrefix = contentBrowserFolderOps(moveTarget?.sourcePath ?? ASSETS_ROOT, browserRoots).pathPrefix;
    const crossRoot = moveTarget?.operation === "move";
    const trees = folderTrees.filter((tree) => tree.path === sourcePrefix ||
      (crossRoot && !readOnlyRootPrefixes.includes(tree.path)));
    return trees.length > 0 ? trees : folderTrees.slice(0, 1);
  }, [browserRoots, folderTrees, moveTarget?.operation, moveTarget?.sourcePath, readOnlyRootPrefixes]);

  const moveWarnings = useMemo(() => {
    if (!moveTarget || moveTarget.operation !== "move") return [];
    const plan = planMoveTarget(moveTarget);
    return plan.error ? [] : crossRootMoveWarnings(plan.moves, moveTarget.folderPath);
  }, [crossRootMoveWarnings, moveTarget, planMoveTarget]);

  const confirmMove = useCallback(async () => {
    if (!assetRegistry || !moveTarget) return;
    const destPath = moveTarget.folderPath;
    const dest = contentBrowserFolderOps(destPath, browserRoots);
    if (dest.readOnly) {
      setOperationError(`${destPath} is read-only. Choose a folder in project content.`);
      return;
    }
    const plan = planMoveTarget(moveTarget);
    if (plan.error) {
      setOperationError(plan.error);
      return;
    }
    const { moves } = plan;
    setBusy(true);
    setOperationError(null);
    const remainingGuids = new Set(moves.flatMap((move) => move.guid ? [move.guid] : []));
    const remainingFolders = new Set(moves.flatMap((move) => move.kind === "folder" ? [move.sourcePath] : []));
    const total = remainingGuids.size + remainingFolders.size;
    try {
      if (moveTarget.operation === "copy") {
        const steps = moves.flatMap((move): CopyStep[] => {
          if (move.kind === "folder") {
            const from = contentBrowserFolderOps(move.sourcePath, browserRoots);
            return [{
              name: move.sourcePath.slice(move.sourcePath.lastIndexOf("/") + 1),
              units: folderAssetCount(move.sourcePath),
              run: async (options) => {
                const copy = await assetRegistry.copyFolder(from.rootId, from.relative, dest.relative, options);
                return () => assetRegistry.deleteFolder(from.rootId, copy);
              },
              onDone: () => remainingFolders.delete(move.sourcePath),
            }];
          }
          const guid = move.guid;
          if (!guid) return [];
          return [{
            name: assetRegistry.getByGuid(guid)?.header.name ?? guid,
            units: 1,
            run: async (options) => {
              const copy = await assetRegistry.copyAsset(guid, dest.rootId, dest.relative, options);
              return () => assetRegistry.deleteAsset(copy.header.guid);
            },
            onDone: () => remainingGuids.delete(guid),
          }];
        });
        if (!(await runCopySteps("copy", steps))) {
          // Canceled: every copy was removed again, so nothing remains to retry.
          await refreshAssetRegistry();
          setMoveTarget(null);
          return;
        }
      } else {
        await applyRegistryMoves(moves, (move) => {
          if (move.kind === "folder") remainingFolders.delete(move.sourcePath);
          else if (move.guid) remainingGuids.delete(move.guid);
        });
      }
      await refreshAssetRegistry();
      setMoveTarget(null);
    } catch (error) {
      const remaining = remainingGuids.size + remainingFolders.size;
      await refreshAssetRegistry();
      const completed = total - remaining;
      const message = error instanceof Error ? error.message : String(error);
      if (completed > 0) {
        const guids = [...remainingGuids];
        const folders = [...remainingFolders];
        setMoveTarget(remaining > 0 ? {
          ...moveTarget,
          guids,
          folderPaths: folders,
          assetPaths: guids.flatMap((guid) => {
            const asset = assetRegistry.getByGuid(guid);
            return asset ? [asset.path] : [];
          }),
          itemCount: remaining,
          kind: guids.length === 0 ? "folder" : "asset",
          name: contentBrowserMovePreviewName([
            ...folders.map((path) => path.split("/").at(-1) ?? path),
            ...guids.map((guid) => assetRegistry.getByGuid(guid)?.header.name ?? guid),
          ]),
        } : null);
      }
      setOperationError(completed > 0
        ? `${completed} item${completed === 1 ? "" : "s"} ${moveTarget.operation === "copy" ? "copied" : "moved"}. ${message}${remaining > 0 ? " Retry to process only the remaining items." : " The file operation completed; the follow-up step failed."}`
        : message);
    } finally {
      setBusy(false);
    }
  }, [
    applyRegistryMoves,
    assetRegistry,
    moveTarget,
    planMoveTarget,
    refreshAssetRegistry,
    browserRoots,
    folderAssetCount,
    runCopySteps,
    setBusy,
    setMoveTarget,
    setOperationError,
  ]);

  const handleTreeReparent = useCallback(
    (
      dragId: string,
      targetId: string | null,
      placement?: TreeDropPlacement,
    ) => {
      if (!assetRegistry || busy) return;
      const moves = contentBrowserTreeDropMoves({
        dragId,
        targetId,
        rows: browserRows,
        selectedGuids,
        selectedFolderPaths,
        rootPaths: rootPrefixes,
        readOnlyRootPaths: readOnlyRootPrefixes,
        resolvePath: (guid) => assetRegistry.getByGuid(guid)?.path,
        placement,
      });
      if (moves.length === 0) return;
      // Refuse before moving anything, so a taken name cannot stop the drop halfway.
      const collision = moveNameCollision(moves, existingContentPaths);
      if (collision) {
        setOperationError(collision);
        return;
      }
      // A drop that changes plugin behaviour asks first: file moves cannot be undone.
      const destinationPath = moves[0]!.destinationPath;
      if (crossRootMoveWarnings(moves, destinationPath).length > 0) {
        openMoveDialog(
          "move",
          moves.flatMap((move) => move.kind === "folder" ? [move.sourcePath] : []),
          moves.flatMap((move) => move.guid ? [move.guid] : []),
          destinationPath,
        );
        return;
      }
      void (async () => {
        setBusy(true);
        setOperationError(null);
        try {
          try {
            await applyRegistryMoves(moves);
          } finally {
            await refreshAssetRegistry();
          }
        } catch (error) {
          setOperationError(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [
      applyRegistryMoves,
      assetRegistry,
      browserRows,
      busy,
      crossRootMoveWarnings,
      existingContentPaths,
      openMoveDialog,
      readOnlyRootPrefixes,
      refreshAssetRegistry,
      rootPrefixes,
      selectedFolderPaths,
      selectedGuids,
      setBusy,
      setOperationError,
    ],
  );

  const dialogKey =
    moveTarget
      ? `${moveTarget.operation}:${moveTarget.guids.join(",")}:${moveTarget.folderPaths.join(",")}`
      : "closed";
  const dialogProps: ContentBrowserMoveDialogProps = {
    open: moveTarget !== null,
    onOpenChange: (open) => {
      if (!open) setMoveTarget(null);
    },
    kind: moveTarget?.kind ?? "asset",
    operation: moveTarget?.operation ?? "move",
    name: moveTarget?.name ?? "",
    currentFolderPath:
      moveTarget
        ? moveTarget.kind === "folder"
          ? parentFolderPath(
              moveTarget.sourcePath,
              contentBrowserFolderOps(moveTarget.sourcePath, browserRoots)
                .pathPrefix,
            )
          : moveTarget.assetPaths[0]
            ? parentFolderPath(moveTarget.assetPaths[0])
            : moveTarget.sourcePath
        : ASSETS_ROOT,
    folderTrees: moveFolderTrees,
    destinationPath: moveTarget?.folderPath ?? ASSETS_ROOT,
    onDestinationChange: (path) =>
      setMoveTarget((current) =>
        current ? { ...current, folderPath: path } : current,
      ),
    onConfirm: () => void confirmMove(),
    busy,
    error: operationError,
    typeVisual: moveTarget?.typeVisual ?? null,
    itemCount: moveTarget?.itemCount,
    assetPaths: moveTarget?.assetPaths ?? NO_PATHS,
    folderPaths: moveTarget?.folderPaths ?? NO_PATHS,
    rootPaths: rootPrefixes,
    readOnlyRootPaths: readOnlyRootPrefixes,
    existingPaths: existingContentPaths,
    warnings: moveWarnings,
  };
  const copyProgressDialogProps: ContentBrowserCopyProgressDialogProps = {
    progress: copyProgress,
    onCancel: cancelCopy,
  };

  return {
    runCopySteps,
    folderAssetCount,
    openMoveForSnapshot,
    handleTreeReparent,
    copyProgressDialogProps,
    dialogKey,
    dialogProps,
  };
}
