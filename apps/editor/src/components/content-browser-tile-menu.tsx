import {
  ArrowUpRightIcon,
  BoneIcon,
  CopyIcon,
  CopyPlusIcon,
  FileInputIcon,
  FolderInputIcon,
  ImageIcon,
  LinkIcon,
  PaintbrushIcon,
  PencilIcon,
  Trash2Icon,
  WaypointsIcon,
} from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  groupMsdfImportBatch,
  newAssetGuid,
  stripAssetFileSuffix,
  type AssetCopyOptions,
  type AssetRegistry,
  type IndexedAsset,
} from "@haptic/assets";
import type { ProjectDocument } from "@haptic/core";
import { pickImportFiles } from "@haptic/vfs";
import { enqueueModelThumbnailJobs, type ModelThumbnailJob } from "../lib/model-thumbnail-queue";
import { createAssetThumbnailRevisionIndex } from "../lib/asset-thumbnail-revision";
import type { useKeybindings } from "../context/keybind-context";
import {
  buildMaterialInstanceAssetResult,
  guidsOutsideSelectedFolders,
  isFolderTreeRoot,
  isNewAssetNameTaken,
  materialInstanceNameFor,
  newAssetFileName,
  parentFolderPath,
  rootSelectedFolderPaths,
} from "../lib/content-browser-helpers";
import { contentBrowserFolderOps } from "../lib/plugin-ui";
import type { ContentBrowserCopyProgress } from "./content-browser-copy-progress-dialog";
import type { ImportProgress } from "./import-progress-dialog";
import type { NameEntry } from "./content-browser-name-dialog";

/** One item of a Copy to Folder or Duplicate; `run` returns how to remove its copy. */
export type CopyStep = {
  name: string;
  /** Files the step writes, for the progress total. */
  units: number;
  run: (options: AssetCopyOptions) => Promise<() => Promise<void>>;
  onDone?: () => void;
};

/** What the asset tile context menu reads from the Content Browser and acts through. */
export interface ContentBrowserTileMenuDeps {
  /** The assets and folders the open menu acts on. */
  menuTargetGuidsRef: RefObject<string[]>;
  menuTargetFoldersRef: RefObject<string[]>;
  assetRegistry: AssetRegistry | null;
  projectGuid: string | null;
  projectDocument: ProjectDocument | null;
  thumbnailsEnabled: boolean;
  selectedFolderPath: string;
  browserRoots: Parameters<typeof contentBrowserFolderOps>[1];
  rootPrefixes: readonly string[];
  busy: boolean;
  keybinds: ReturnType<typeof useKeybindings>;
  importAbortRef: RefObject<AbortController | null>;
  openOrFocusDocument: (asset: IndexedAsset) => Promise<void>;
  setImportErrors: (errors: string[] | null) => void;
  updateImportProgress: (signal: AbortSignal, patch: Partial<ImportProgress>) => void;
  setImportProgress: (progress: ImportProgress | null) => void;
  refreshAssetRegistry: () => Promise<void>;
  noteAssetsCreated: () => void;
  setBusy: (busy: boolean) => void;
  setOperationError: (error: string | null) => void;
  folderAssetCount: (path: string) => number;
  runCopySteps: (operation: ContentBrowserCopyProgress["operation"], steps: readonly CopyStep[]) => Promise<boolean>;
  setNameDialog: Dispatch<SetStateAction<NameEntry | null>>;
  setRetargetPickerOpen: (open: boolean) => void;
  openMoveForSnapshot: (operation: "move" | "copy") => void;
  setReferenceGuid: (guid: string | null) => void;
  requestDeleteSnapshot: (guids: string[], folderPaths: string[]) => void;
}

/** The asset tile context menu: Open, thumbnails, Material Instance, Duplicate, Rename, Move, Copy, References and Delete. */
export function contentBrowserTileMenuItems(deps: ContentBrowserTileMenuDeps) {
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
  } = deps;
  return [
    {
      id: "open" as const,
      label: "Open",
      icon: <ArrowUpRightIcon />,
      onSelect: () => {
        const guid = menuTargetGuidsRef.current[0];
        if (!guid || !assetRegistry) return;
        const asset = assetRegistry.getByGuid(guid);
        if (!asset) return;
        void openOrFocusDocument(asset);
      },
    },
    {
      id: "generate-thumbnail" as const,
      label: "Generate Thumbnail",
      icon: <ImageIcon />,
      onSelect: () => {
        if (!assetRegistry || !projectGuid || !thumbnailsEnabled) return;
        const guids = [...menuTargetGuidsRef.current];
        const revisions = createAssetThumbnailRevisionIndex(
          assetRegistry.list(), projectDocument?.settings.twoD?.pixelsPerUnit,
        );
        void (async () => {
          const jobs: ModelThumbnailJob[] = [];
          for (const guid of guids) {
            const asset = assetRegistry.getByGuid(guid);
            if (!asset) continue;
            const type = asset.header.type;
            if (type !== "Model" && type !== "Animation" && type !== "Material" && type !== "Class") continue;
            jobs.push({
              guid, path: asset.path, type, payload: asset.header.payload,
              projectGuid, cacheKey: await revisions.cacheKey(guid) ?? guid,
            });
          }
          enqueueModelThumbnailJobs(jobs);
        })().catch((error) => setImportErrors([error instanceof Error ? error.message : String(error)]));
      },
    },
    {
      id: "import-msdf-atlas" as const,
      label: "Import MSDF Atlas…",
      icon: <FileInputIcon />,
      onSelect: () => {
        void (async () => {
          const guid = menuTargetGuidsRef.current[0];
          if (!guid || !assetRegistry) return;
          const asset = assetRegistry.getByGuid(guid);
          if (!asset || asset.header.type !== "Font") return;
          try {
            const files = await pickImportFiles({
              multiple: true,
              accept: ".json,.png",
            });
            if (!files.length) return;
            const prepared = groupMsdfImportBatch(files);
            const browse = contentBrowserFolderOps(
              selectedFolderPath,
              browserRoots,
            );
            if (browse.readOnly) return;
            const controller = new AbortController();
            importAbortRef.current = controller;
            try {
              for (const [index, file] of prepared.entries()) {
                updateImportProgress(controller.signal, { phase: file.name, completed: index, total: prepared.length, fraction: null });
                await assetRegistry.importFile(
                  asset.rootId,
                  browse.relative,
                  file.name,
                  file.bytes,
                  {
                    sidecars: file.sidecars,
                    attachToGuid: guid,
                    signal: controller.signal,
                  },
                );
              }
            } finally {
              if (importAbortRef.current === controller) importAbortRef.current = null;
              setImportProgress(null);
              await refreshAssetRegistry();
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            setImportErrors([
              err instanceof Error ? err.message : String(err),
            ]);
          }
        })();
      },
    },
    {
      id: "create-material-instance" as const,
      label: "Create Material Instance",
      icon: <PaintbrushIcon />,
      onSelect: () => {
        if (busy) return;
        void (async () => {
          const guid = menuTargetGuidsRef.current[0];
          const parent = guid ? assetRegistry?.getByGuid(guid) : undefined;
          if (!assetRegistry || !parent) return;
          // Beside its parent, so a Material and its instances stay together.
          const folder = parentFolderPath(parent.path);
          const browse = contentBrowserFolderOps(folder, browserRoots);
          if (browse.readOnly) return;
          const paths = assetRegistry.list().map((asset) => asset.path);
          const name = materialInstanceNameFor(parent.header.name, (candidate) =>
            isNewAssetNameTaken(paths, folder, "MaterialInstance", candidate));
          const fileName = newAssetFileName("MaterialInstance", name);
          if (!fileName) return;
          setBusy(true);
          setOperationError(null);
          try {
            const created = await assetRegistry.createAsset(
              browse.rootId,
              browse.relative ? `${browse.relative}/${fileName}` : fileName,
              buildMaterialInstanceAssetResult(parent.header, newAssetGuid(), name),
            );
            // The mounted registry indexed the instance on write: no rescan.
            noteAssetsCreated();
            await openOrFocusDocument(created);
          } catch (error) {
            setOperationError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        })();
      },
    },
    {
      id: "duplicate" as const,
      label: "Duplicate",
      icon: <CopyPlusIcon />,
      shortcut: keybinds.get("edit.duplicate")?.[0],
      onSelect: () => {
        if (busy || !assetRegistry) return;
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
        // Each copy is written beside its source, as folder duplicates are.
        const sources = [
          ...folders.map((path) => ({ guid: null, path, from: contentBrowserFolderOps(path, browserRoots) })),
          ...guids.flatMap((guid) => {
            const path = assetRegistry.getByGuid(guid)?.path;
            return path ? [{ guid, path, from: contentBrowserFolderOps(parentFolderPath(path), browserRoots) }] : [];
          }),
        ];
        const readOnly = sources.find(({ from }) => from.readOnly);
        if (readOnly) {
          setOperationError(`${readOnly.from.pathPrefix} is read-only.`);
          return;
        }
        const steps: CopyStep[] = sources.map(({ guid, path, from }) => guid
          ? {
            name: assetRegistry.getByGuid(guid)?.header.name ?? guid,
            units: 1,
            run: async (options) => {
              const copy = await assetRegistry.duplicateAsset(guid, from.rootId, from.relative, options);
              return () => assetRegistry.deleteAsset(copy.header.guid);
            },
          }
          : {
            name: path.slice(path.lastIndexOf("/") + 1),
            units: folderAssetCount(path),
            run: async (options) => {
              const copy = await assetRegistry.duplicateFolder(from.rootId, from.relative, options);
              return () => assetRegistry.deleteFolder(from.rootId, copy);
            },
          });
        void (async () => {
          setBusy(true);
          setOperationError(null);
          try {
            try {
              await runCopySteps("duplicate", steps);
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
    },
    {
      id: "rename" as const,
      label: "Rename",
      icon: <PencilIcon />,
      shortcut: keybinds.get("edit.rename")?.[0],
      onSelect: () => {
        const folders = menuTargetFoldersRef.current.filter(
          (path) => !isFolderTreeRoot(path, rootPrefixes),
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
          value: stripAssetFileSuffix(asset.path.split("/").at(-1) ?? asset.header.name),
        });
      },
    },
    {
      id: "retarget" as const,
      label: "Retarget…",
      icon: <BoneIcon />,
      testId: "content-browser-retarget",
      onSelect: () => setRetargetPickerOpen(true),
    },
    {
      id: "move" as const,
      label: "Move…",
      icon: <FolderInputIcon />,
      onSelect: () => openMoveForSnapshot("move"),
    },
    {
      id: "copy" as const,
      label: "Copy to Folder…",
      icon: <CopyIcon />,
      onSelect: () => openMoveForSnapshot("copy"),
    },
    {
      id: "copy-asset-reference" as const,
      label: "Copy Asset Reference",
      icon: <LinkIcon />,
      onSelect: () => {
        const guid = menuTargetGuidsRef.current[0];
        if (!guid) return;
        void navigator.clipboard.writeText(guid);
      },
    },
    {
      id: "show-references" as const,
      label: "Show References",
      shortcut: keybinds.get("browser.references")?.[0],
      icon: <WaypointsIcon />,
      onSelect: () => {
        const guid = menuTargetGuidsRef.current[0];
        if (!guid || !assetRegistry) return;
        setReferenceGuid(guid);
      },
    },
    {
      id: "delete" as const,
      label: "Delete",
      icon: <Trash2Icon />,
      variant: "destructive" as const,
      shortcut: keybinds.get("edit.delete")?.[0],
      onSelect: () =>
        requestDeleteSnapshot(
          menuTargetGuidsRef.current,
          menuTargetFoldersRef.current,
        ),
    },
  ];
}
