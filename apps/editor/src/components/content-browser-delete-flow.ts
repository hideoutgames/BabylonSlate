import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from "react";
import { FolderIcon } from "lucide-react";
import type { AssetRegistry, FolderNode, IndexedAsset } from "@haptic/assets";
import { resolveTypeVisual } from "@haptic/editor-kit";
import type { useDocumentActions, useProjectState, useSourceControl } from "../context/document-context";
import type { OpenDocument } from "../services/document-service";
import { classAssetReference, classDeletionCandidates, validateClassDeletionReplacements } from "../lib/class-deletion";
import { containedAssetPaths, oursLockPaths } from "../lib/source-control-file-ops";
import {
  assetDependenciesIncludingOpenDocuments,
  classIdFromClassAsset,
  collectFolderGuidsFromTrees,
  contentBrowserDeleteListNames,
  contentBrowserDeletingGuids,
  deleteTargetFolders,
  isFolderTreeRoot,
  lastSceneClassDeleteLines,
  parentFolderPath,
  rootSelectedFolderPaths,
  type DeleteTarget,
} from "../lib/content-browser-helpers";
import { contentBrowserFolderOps, type ContentBrowserRoot } from "../lib/plugin-ui";
import type { ContentBrowserDeleteDialogs } from "./content-browser-delete-dialogs";

/** What Delete reads from the Content Browser and acts through. */
export interface ContentBrowserDeleteFlowDeps extends Pick<
  ReturnType<typeof useDocumentActions>,
  "closeDocumentsForPaths" | "replaceClassReferencesBeforeDelete" | "repairAfterAssetDelete"
> {
  /** Owned by the workspace, which also reads it to tell which operation dialog is open. */
  deleteTarget: DeleteTarget | null;
  setDeleteTarget: Dispatch<SetStateAction<DeleteTarget | null>>;
  assetRegistry: AssetRegistry | null;
  allAssets: IndexedAsset[];
  referenceAssets: IndexedAsset[];
  openDocuments: OpenDocument[];
  folderTrees: FolderNode[];
  rootPrefixes: string[];
  browserRoots: ContentBrowserRoot[];
  projectDocument: ReturnType<typeof useProjectState>["projectDocument"];
  selectedGuids: Set<string>;
  selectedFolderPaths: Set<string>;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  setSelectedGuids: Dispatch<SetStateAction<Set<string>>>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setOperationError: (error: string | null) => void;
  refuseTheirsAssetPaths: (paths: string[]) => boolean;
  sourceControl: ReturnType<typeof useSourceControl>["sourceControl"];
}

/**
 * Delete: the confirm, referenced-asset and Class replacement dialogs, and
 * the blocking deletion that closes tabs, releases locks and repairs references.
 */
export function useContentBrowserDeleteFlow(deps: ContentBrowserDeleteFlowDeps) {
  const {
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
  } = deps;
  const [classReplacementChoices, setClassReplacementChoices] = useState<Record<string, string | null>>({});
  const [replacementPicker, setReplacementPicker] = useState<string | null>(null);
  const [confirmReferencedDelete, setConfirmReferencedDelete] = useState(false);
  useEffect(() => {
    setClassReplacementChoices({});
    setReplacementPicker(null);
    setConfirmReferencedDelete(false);
  }, [deleteTarget]);
  const [deleteProgress, setDeleteProgress] = useState<{
    done: number;
    total: number;
    currentName: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  const requestDelete = useCallback((guids: string[]) => {
    if (guids.length === 0) return;
    setDeleteTarget({ kind: "assets", guids });
  }, [setDeleteTarget]);

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
    [folderTrees, rootPrefixes, setDeleteTarget],
  );

  const requestDeleteSnapshot = useCallback(
    (guids: string[], folderPaths: string[]) => {
      // A range selection can hold a folder and its descendants; delete the outermost.
      const folders = rootSelectedFolderPaths(folderPaths.filter(
        (path) => !isFolderTreeRoot(path, rootPrefixes),
      ));
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
        guids: extraGuids,
      });
    },
    [folderTrees, requestDelete, requestDeleteFolder, rootPrefixes, setDeleteTarget],
  );

  const requestDeleteSelection = useCallback(() => {
    requestDeleteSnapshot([...selectedGuids], [...selectedFolderPaths]);
  }, [requestDeleteSnapshot, selectedFolderPaths, selectedGuids]);

  const resolveAssetName = useCallback(
    (guid: string) => {
      const asset = assetRegistry?.getByGuid(guid);
      return asset?.header.name.trim() || asset?.path.split("/").at(-1) || guid;
    },
    [assetRegistry],
  );

  const deletingGuids = useMemo(() => contentBrowserDeletingGuids({
    extraGuids: deleteTarget?.guids ?? [],
    folderPaths: deleteTargetFolders(deleteTarget),
    assets: allAssets,
  }), [allAssets, deleteTarget]);
  const deletingClassGuids = useMemo(() => new Set(referenceAssets
    .filter((asset) => deletingGuids.has(asset.header.guid) && asset.header.type === "Class")
    .map((asset) => asset.header.guid)), [deletingGuids, referenceAssets]);
  const deleteInboundRefs = useMemo(() => {
    if (!deleteTarget || !assetRegistry) return [];
    // One dependency pass for the whole project, not one per deleted guid.
    const refs = new Map<string, string[]>();
    for (const [inbound, dependencies] of assetDependenciesIncludingOpenDocuments(referenceAssets, openDocuments)) {
      if (deletingGuids.has(inbound)) continue;
      const targets = dependencies.filter((guid) => deletingGuids.has(guid));
      if (targets.length > 0) refs.set(inbound, targets);
    }
    const rows = [...refs].map(([guid, targets]) => {
      const asset = assetRegistry.getByGuid(guid);
      return { guid, name: resolveAssetName(guid), path: asset?.path ?? guid,
        type: asset?.header.type, targets: targets.map(resolveAssetName), targetGuids: targets,
        blocksClassDelete: targets.some((target) => deletingClassGuids.has(target)) };
    });
    const projectClasses = new Set([
      projectDocument?.settings.gameInstanceClass,
      ...(projectDocument?.settings.editorUtilityObjects ?? []),
    ]);
    const projectAssetGuids = new Set([
      projectDocument?.settings.startupSceneGuid,
      projectDocument?.settings.audio?.audioMixerGuid,
      projectDocument?.settings.fonts?.defaultFontGuid,
    ]);
    const projectTargets = referenceAssets.filter((asset) =>
      deletingGuids.has(asset.header.guid) && (projectAssetGuids.has(asset.header.guid) ||
        (deletingClassGuids.has(asset.header.guid) && projectClasses.has(classIdFromClassAsset(asset)))),
    );
    if (projectTargets.length > 0) rows.push({
      guid: "project-settings", name: "Project Settings", path: "project.json", type: undefined,
      targets: projectTargets.map((asset) => resolveAssetName(asset.header.guid)),
      targetGuids: projectTargets.map((asset) => asset.header.guid),
      blocksClassDelete: projectTargets.some((asset) => deletingClassGuids.has(asset.header.guid)),
    });
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }, [assetRegistry, referenceAssets, openDocuments, deleteTarget, resolveAssetName,
    deletingGuids, deletingClassGuids, projectDocument]);
  const hasReferencedClass = deleteInboundRefs.some((ref) => ref.blocksClassDelete);
  const deletedClasses = useMemo(() => referenceAssets.filter((asset) => deletingClassGuids.has(asset.header.guid)), [referenceAssets, deletingClassGuids]);
  const classReplacements = useMemo(() => deletedClasses.map((asset) => {
    const replacement = referenceAssets.find((candidate) => candidate.header.guid === classReplacementChoices[asset.header.guid]);
    const selectedGuid = classReplacementChoices[asset.header.guid];
    return { ...classAssetReference(asset), replacement: replacement ? classAssetReference(replacement)
      : selectedGuid ? { guid: selectedGuid, classId: "" } : null };
  }), [deletedClasses, referenceAssets, classReplacementChoices]);
  const pickerSource = deletedClasses.find((asset) => asset.header.guid === replacementPicker);
  const pickerCandidates = pickerSource ? classDeletionCandidates(pickerSource, referenceAssets, deletingGuids) : [];

  const deleteListNames = useMemo(() => {
    if (!deleteTarget) return [];
    if (deleteTarget.kind === "folder") {
      return contentBrowserDeleteListNames({
        folderPaths: [deleteTarget.path],
      });
    }
    const assetNames = deleteTarget.guids.map(resolveAssetName);
    if (deleteTarget.kind === "selection") {
      return contentBrowserDeleteListNames({
        folderPaths: deleteTarget.folders,
        assetNames,
      });
    }
    return contentBrowserDeleteListNames({ assetNames });
  }, [deleteTarget, resolveAssetName]);

  const deleteListItems = useMemo(() => {
    if (!deleteTarget) return [];
    const folders = deleteTargetFolders(deleteTarget);
    return [
      ...folders.map((path) => {
        const count = containedAssetPaths(allAssets, path).length;
        return { key: path, name: path.split("/").pop() || path, detail: path,
          count: count === 1 ? "1 Asset" : `${count} Assets`,
          visual: { ...resolveTypeVisual({ family: "folder" }), icon: FolderIcon, iconKey: "Folder" } };
      }),
      ...(deleteTarget.kind === "folder" ? [] : deleteTarget.guids).map((guid) => {
        const asset = assetRegistry?.getByGuid(guid);
        return { key: guid, name: resolveAssetName(guid), detail: asset?.path ?? guid,
          count: null, visual: resolveTypeVisual({ assetType: asset?.header.type }) };
      }),
    ];
  }, [allAssets, assetRegistry, deleteTarget, resolveAssetName]);

  const deleteLastSceneClassLines = useMemo(
    () => deleteTarget ? lastSceneClassDeleteLines(allAssets, deletingGuids) : [],
    [allAssets, deleteTarget, deletingGuids],
  );

  const confirmDelete = useCallback(async () => {
    if (busy || !assetRegistry || !deleteTarget) return;
    const paths = new Set<string>();
    for (const guid of deleteTarget.guids) {
      const path = assetRegistry.getByGuid(guid)?.path;
      if (path) paths.add(path);
    }
    const folders = deleteTargetFolders(deleteTarget);
    for (const folder of folders) {
      for (const path of containedAssetPaths(allAssets, folder)) {
        paths.add(path);
      }
    }
    const readOnly =
      folders.find((path) => contentBrowserFolderOps(path, browserRoots).readOnly) ??
      [...paths].find((path) => contentBrowserFolderOps(parentFolderPath(path), browserRoots).readOnly);
    if (readOnly) {
      setDeleteTarget(null);
      setDeleteError(`${readOnly} is read-only and cannot be deleted.`);
      return;
    }
    if (refuseTheirsAssetPaths([...paths, ...deleteInboundRefs.filter((ref) => ref.blocksClassDelete && ref.guid !== "project-settings").map((ref) => ref.path)])) return;
    const oursToRelease = oursLockPaths([...paths], (path) =>
      sourceControl.lockStateForPath(path),
    );
    const individualGuids = deleteTarget.kind === "folder"
      ? []
      : deleteTarget.guids.filter((guid) => {
          const path = assetRegistry.getByGuid(guid)?.path;
          return path && !folders.some((folder) => path.startsWith(`${folder}/`));
        });
    const total = folders.length + individualGuids.length + 1;
    let done = 0;
    const reportProgress = async (currentName: string) => {
      setDeleteProgress({ done, total, currentName });
      // Allow React and the browser to paint before the next work slice.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    const removedGuids = new Set<string>();
    const removedFolders: string[] = [];
    setBusy(true);
    setDeleteTarget(null);
    setDeleteProgress({ done, total, currentName: "Preparing Deletion" });
    setOperationError(null);
    try {
      await reportProgress("Preparing Deletion");
      if (classReplacements.length > 0) {
        validateClassDeletionReplacements(classReplacements, referenceAssets, deletingGuids);
        await replaceClassReferencesBeforeDelete(classReplacements, deletingGuids, (name) =>
          reportProgress(`Updating Class References: ${name}`));
      }
      try {
        // Each item's tabs close just before it is deleted, so a failure keeps
        // the unsaved edits of every item that was not reached.
        for (const path of folders) {
          const from = contentBrowserFolderOps(path, browserRoots);
          await reportProgress(path);
          closeDocumentsForPaths(containedAssetPaths(allAssets, path));
          await assetRegistry.deleteFolder(from.rootId, from.relative);
          removedFolders.push(path);
          for (const asset of allAssets) {
            if (asset.path.startsWith(`${path}/`)) removedGuids.add(asset.header.guid);
          }
          done += 1;
          setSelectedFolderPath((current) =>
            current === path || current.startsWith(`${path}/`)
              ? parentFolderPath(path, from.pathPrefix)
              : current,
          );
        }
        for (const guid of individualGuids) {
          const asset = assetRegistry.getByGuid(guid);
          if (asset) {
            await reportProgress(asset.header.name);
            closeDocumentsForPaths([asset.path]);
            await assetRegistry.deleteAsset(guid);
            removedGuids.add(guid);
          }
          done += 1;
        }
      } finally {
        // Repair successful removals even if a later file operation fails.
        if (removedGuids.size > 0 || done > 0) {
          await reportProgress("Updating References");
          for (const path of oursToRelease) {
            if (allAssets.some((asset) => asset.path === path && removedGuids.has(asset.header.guid))) {
              await sourceControl.releasePath(path);
            }
          }
          // Stored Class references and parentClass use the compile id, not the display name.
          const removedClassNames = new Set(allAssets
            .filter((asset) => removedGuids.has(asset.header.guid) && asset.header.type === "Class")
            .map(classIdFromClassAsset));
          await repairAfterAssetDelete(removedGuids, removedClassNames, (name) =>
            reportProgress(`Updating References: ${name}`), removedFolders,
          );
        }
      }
      setSelectedGuids(new Set());
      setSelectedFolderPaths(new Set());
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteProgress(null);
      setBusy(false);
    }
  }, [
    allAssets,
    assetRegistry,
    browserRoots,
    busy,
    closeDocumentsForPaths,
    deleteTarget,
    deleteInboundRefs,
    classReplacements,
    referenceAssets,
    deletingGuids,
    replaceClassReferencesBeforeDelete,
    repairAfterAssetDelete,
    refuseTheirsAssetPaths,
    sourceControl,
    setBusy,
    setDeleteTarget,
    setOperationError,
    setSelectedFolderPath,
    setSelectedFolderPaths,
    setSelectedGuids,
  ]);

  const dialogProps: ComponentProps<typeof ContentBrowserDeleteDialogs> = {
    deleteTarget,
    setDeleteTarget,
    confirmReferencedDelete,
    setConfirmReferencedDelete,
    replacementPicker,
    setReplacementPicker,
    classReplacementChoices,
    setClassReplacementChoices,
    deleteCancelRef,
    deleteInboundRefs,
    deleteListItems,
    deleteListNames,
    hasReferencedClass,
    deleteLastSceneClassLines,
    deletedClasses,
    pickerCandidates,
    classReplacements,
    resolveAssetName,
    busy,
    confirmDelete,
    deleteProgress,
    deleteError,
    setDeleteError,
  };

  return { requestDeleteSnapshot, requestDeleteSelection, dialogProps };
}
