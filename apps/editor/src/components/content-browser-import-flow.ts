import { useCallback, useRef, useState } from "react";
import {
  describeSkippedZipEntries,
  embedGltfImportBatch,
  expandImportZip,
  groupMsdfImportBatch,
  isImportableFileName,
  isZipFileName,
  pickerImportAccept,
  zipImportFolderName,
  type AssetRegistry,
  type ExpandedImportZip,
  type ImportFileBytes,
} from "@haptic/assets";
import { convertObjImportBatch, convertStlImportBatch } from "@haptic/render";
import { convertFbxImportBatch } from "@haptic/render/fbx-import";
import { createAppSettingsStore, isMobilePlatform, pickImportFiles } from "@haptic/vfs";
import type { useDocumentActions } from "../context/document-context";
import type { useOptionalPlay } from "../context/play-context";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { freeFolderName, joinAssetFolderPath, runWithContentBrowserImportBusy } from "../lib/content-browser-helpers";
import { filterHpluginFiles, type contentBrowserFolderOps } from "../lib/plugin-ui";
import type { ImportProgress, ImportProgressDialogProps } from "./import-progress-dialog";

/** What Import reads from the Content Browser and acts through. */
export interface ContentBrowserImportFlowDeps extends Pick<
  ReturnType<typeof useDocumentActions>,
  "refreshAssetRegistry"
> {
  assetRegistry: AssetRegistry | null;
  /** The open folder's content root and path, where imported assets go. */
  selectedRoot: ReturnType<typeof contentBrowserFolderOps>;
  /** Every folder the Content Browser lists, so a ZIP's folder takes a free name. */
  existingFolderPaths: readonly string[];
  /** Its shared Engine converts OBJ and STL models. */
  play: ReturnType<typeof useOptionalPlay>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

/** One folder's share of an import: the loose files picked, or one ZIP's files under its new folder. */
type ImportGroup = {
  /** The folder the group's files go in, relative to the open folder ("" for loose files). */
  folder: string;
  files: ImportFileBytes[];
  /** Assets that landed in the folder; a ZIP's folder with none is removed again. */
  imported: number;
};

/**
 * Converts FBX, OBJ and STL files to GLB, embeds glTF sidecars and pairs MSDF
 * atlases, as one batch: a model finds its sidecars by the paths the batch
 * names them with (a ZIP's folders), else by file name.
 */
async function prepareImportBatch(
  files: ImportFileBytes[],
  conversion: { signal: AbortSignal; onFile: (name: string) => void },
  engine: NonNullable<Parameters<typeof convertObjImportBatch>[1]>["engine"],
): Promise<{ files: ImportFileBytes[]; errors: string[] }> {
  const errors: string[] = [];
  const fbx = await convertFbxImportBatch(files, conversion);
  errors.push(...fbx.errors);
  const obj = await convertObjImportBatch(fbx.files, { ...conversion, engine });
  errors.push(...obj.errors);
  const stl = await convertStlImportBatch(obj.files, { ...conversion, engine });
  errors.push(...stl.errors);
  const embedded = embedGltfImportBatch(stl.files);
  errors.push(...embedded.warnings);
  return {
    files: groupMsdfImportBatch(embedded.files.filter((file) => !fbx.consumedSidecars.includes(file.name))),
    errors,
  };
}

function joinFolder(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Expands each ZIP and creates its folder in the open folder (`Props.zip` →
 * `Props`, or `Props_1` when a folder of that name, in any case, exists),
 * adding one group per ZIP that holds something to import. A ZIP that cannot
 * be read imports nothing; its error and the entries each ZIP skipped go to
 * `errors`. A cancel throws.
 */
async function addZipImportGroups(
  zips: ImportFileBytes[],
  context: {
    assetRegistry: AssetRegistry;
    selectedRoot: ContentBrowserImportFlowDeps["selectedRoot"];
    existingFolderPaths: readonly string[];
    signal: AbortSignal;
    groups: ImportGroup[];
    errors: string[];
    onPhase: (patch: Partial<ImportProgress>) => void;
  },
): Promise<void> {
  const { assetRegistry, selectedRoot, signal, groups, errors, onPhase } = context;
  const openFolder = joinFolder(selectedRoot.pathPrefix, selectedRoot.relative);
  const folderPaths = [...context.existingFolderPaths];
  for (const zip of zips) {
    signal.throwIfAborted();
    onPhase({ phase: `Unzipping ${zip.name}`, completed: 0, total: 1, fraction: 0 });
    let expanded: ExpandedImportZip;
    try {
      expanded = await expandImportZip(zip.bytes, {
        isImportable: isImportableFileName,
        signal,
        onProgress: (fraction) => onPhase({ fraction }),
      });
    } catch (error) {
      signal.throwIfAborted();
      errors.push(`${zip.name}: ${errorMessage(error)}`);
      continue;
    }
    errors.push(...describeSkippedZipEntries(expanded.skipped).map((line) => `${zip.name}: ${line}`));
    if (expanded.files.length === 0) {
      errors.push(`${zip.name}: It holds no files Haptic can import.`);
      continue;
    }
    const folder = freeFolderName(folderPaths, openFolder, zipImportFolderName(zip.name));
    try {
      await assetRegistry.createFolder(selectedRoot.rootId, joinFolder(selectedRoot.relative, folder));
    } catch (error) {
      errors.push(`${zip.name}: ${errorMessage(error)}`);
      continue;
    }
    folderPaths.push(joinAssetFolderPath(openFolder, folder));
    groups.push({ folder, files: expanded.files, imported: 0 });
  }
}

/**
 * Import from the toolbar, the empty grid, a shortcut or the file input,
 * behind the cancelable Importing dialog, with the errors it reports.
 */
export function useContentBrowserImportFlow(deps: ContentBrowserImportFlowDeps) {
  const { assetRegistry, selectedRoot, existingFolderPaths, play, busy, setBusy, refreshAssetRegistry } = deps;
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  /** Shows import progress; once the import is cancelled it keeps reading Canceling. */
  const updateImportProgress = useCallback((signal: AbortSignal, patch: Partial<ImportProgress>) => {
    setImportProgress((current) => ({
      title: "Importing",
      phase: "",
      completed: 0,
      total: 1,
      fraction: null,
      ...current,
      ...patch,
      canceling: signal.aborted,
    }));
  }, []);
  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort();
    setImportProgress((current) => current && { ...current, canceling: true });
  }, []);
  const [importErrors, updateImportErrors] = useState<string[] | null>(null);
  const [importedFileCount, setImportedFileCount] = useState(0);
  const setImportErrors = useCallback((errors: string[] | null) => {
    updateImportErrors(errors);
    setImportedFileCount(0);
  }, []);
  const importInputRef = useRef<HTMLInputElement>(null);

  /**
   * Imports files behind the cancelable Importing dialog. Cancel stops the
   * file in progress (its importer, or the import worker running it) and
   * deletes the assets earlier files made, so the folder is left as it was.
   *
   * A ZIP imports into a new folder named after it (`Props.zip` → `Props`,
   * or `Props_1` when taken), keeping the folders inside it; what it skips is
   * listed with the errors. Its files form their own batch, so its models
   * find their sidecars by path.
   */
  const importPickedFiles = useCallback(
    async (
      files: Array<{ name: string; bytes: Uint8Array }>,
      controller: AbortController = new AbortController(),
    ) => {
      if (!assetRegistry || !files.length || selectedRoot.readOnly) return;
      const { signal } = controller;
      const errors: string[] = [];
      const createdGuids: string[] = [];
      let importedCount = 0;
      const incoming = filterHpluginFiles(files);
      if (incoming.length === 0) return;
      importAbortRef.current = controller;
      const createdModels: Array<{
        guid: string;
        path: string;
        payload: Record<string, unknown>;
        type: "Model" | "Animation";
      }> = [];
      const groups: ImportGroup[] = [
        { folder: "", files: incoming.filter((file) => !isZipFileName(file.name)), imported: 0 },
      ];
      await runWithContentBrowserImportBusy(
        setBusy,
        () => setImportProgress(null),
        async () => {
          try {
            await addZipImportGroups(incoming.filter((file) => isZipFileName(file.name)), {
              assetRegistry,
              selectedRoot,
              existingFolderPaths,
              signal,
              groups,
              errors,
              onPhase: (patch) => updateImportProgress(signal, patch),
            });
            const queue: Array<{ group: ImportGroup; file: ImportFileBytes; path: string }> = [];
            for (const group of groups) {
              if (group.files.length === 0) continue;
              const prefix = group.folder ? `${group.folder}/` : "";
              const prepared = await prepareImportBatch(group.files, {
                signal,
                onFile: (name) => updateImportProgress(signal, { phase: `Converting ${prefix}${name}`, completed: 0, total: 1, fraction: null }),
              }, play?.ensureSharedEngine() ?? undefined);
              errors.push(...prepared.errors.map((error) => `${prefix}${error}`));
              queue.push(...prepared.files.map((file) => ({ group, file, path: `${prefix}${file.name}` })));
            }
            const { modelImportDefaultScale, hdrImportFaceSize } = queue.length > 0
              ? await createAppSettingsStore().load()
              : { modelImportDefaultScale: undefined, hdrImportFaceSize: undefined };
            for (let index = 0; index < queue.length; index += 1) {
              signal.throwIfAborted();
              const { group, file, path } = queue[index]!;
              updateImportProgress(signal, { phase: path, completed: index, total: queue.length, fraction: null });
              const slash = path.lastIndexOf("/");
              try {
                const created = await assetRegistry.importFile(
                  selectedRoot.rootId,
                  joinFolder(selectedRoot.relative, path.slice(0, Math.max(0, slash))),
                  path.slice(slash + 1),
                  file.bytes,
                  {
                    modelImportScale: modelImportDefaultScale,
                    hdrFaceSize: hdrImportFaceSize,
                    sidecars: file.sidecars,
                    signal,
                    onProgress: (fraction) => updateImportProgress(signal, { fraction }),
                  },
                );
                importedCount += 1;
                group.imported += created.length;
                for (const asset of created) {
                  createdGuids.push(asset.header.guid);
                  if (asset.header.type !== "Model" && asset.header.type !== "Animation") continue;
                  createdModels.push({
                    guid: asset.header.guid,
                    path: asset.path,
                    payload: asset.header.payload ?? {},
                    type: asset.header.type,
                  });
                }
              } catch (err) {
                if (signal.aborted) throw err;
                errors.push(`${path}: ${errorMessage(err)}`);
              }
              updateImportProgress(signal, { completed: index + 1, fraction: null });
            }
          } catch (err) {
            if (!signal.aborted) errors.push(errorMessage(err));
          }
          if (signal.aborted) {
            for (const guid of createdGuids.reverse()) {
              try {
                await assetRegistry.deleteAsset(guid);
              } catch {
                // Left for the user to delete; the rest of the cancel still applies.
              }
            }
          }
          // A ZIP's folder goes on Cancel, or when none of its files imported.
          for (const group of groups) {
            if (!group.folder || (!signal.aborted && group.imported > 0)) continue;
            try {
              await assetRegistry.deleteFolder(selectedRoot.rootId, joinFolder(selectedRoot.relative, group.folder));
            } catch {
              // Left for the user to delete, as an asset a cancel could not remove is.
            }
          }
          await refreshAssetRegistry();
        },
      );
      if (importAbortRef.current === controller) importAbortRef.current = null;
      if (signal.aborted) return;
      if (errors.length) {
        setImportErrors(errors);
        setImportedFileCount(importedCount);
      }
      enqueueModelThumbnailJobs(createdModels);
    },
    [assetRegistry, existingFolderPaths, play, refreshAssetRegistry, selectedRoot, setBusy, setImportErrors, updateImportProgress],
  );

  const handleImport = useCallback(async () => {
    if (isMobilePlatform()) {
      try {
        const files = await pickImportFiles({
          multiple: true,
          accept: pickerImportAccept(),
        });
        await importPickedFiles(files);
      } catch (err) {
        setImportErrors([
          err instanceof Error ? err.message : String(err),
        ]);
      }
      return;
    }
    importInputRef.current?.click();
  }, [importPickedFiles, setImportErrors]);

  const handleImportInputChange = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList?.length || busy) return;
      const controller = new AbortController();
      importAbortRef.current = controller;
      setBusy(true);
      setImportErrors(null);
      let readingName: string | null = null;
      try {
        const selected = Array.from(fileList);
        const files: Array<{ name: string; bytes: Uint8Array }> = [];
        for (const file of selected) {
          controller.signal.throwIfAborted();
          readingName = file.name;
          updateImportProgress(controller.signal, { phase: `Reading ${file.name}`, completed: files.length, total: selected.length, fraction: null });
          files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        }
        readingName = null;
        controller.signal.throwIfAborted();
        await importPickedFiles(files, controller);
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          setImportErrors([readingName ? `${readingName}: ${message}` : message]);
        }
      } finally {
        if (importAbortRef.current === controller) importAbortRef.current = null;
        setImportProgress(null);
        setBusy(false);
      }
    },
    [busy, importPickedFiles, setBusy, setImportErrors, updateImportProgress],
  );

  const progressDialogProps: ImportProgressDialogProps = {
    progress: importProgress,
    onCancel: cancelImport,
  };

  return {
    importAbortRef,
    updateImportProgress,
    setImportProgress,
    setImportErrors,
    importErrors,
    importedFileCount,
    importInputRef,
    handleImport,
    handleImportInputChange,
    progressDialogProps,
  };
}
