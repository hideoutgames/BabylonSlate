import { useCallback, useRef, useState } from "react";
import { useExecuteJavaScriptReview } from "./execute-javascript-import-dialog";
import type { ExecuteJavaScriptAsset } from "@haptic/core";
import {
  describeSkippedZipEntries,
  embedGltfImportBatch,
  executeJavaScriptInImportFile,
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
import { convertObjImportBatch } from "@haptic/render/convert-obj-to-glb";
import { convertStlImportBatch } from "@haptic/render/convert-stl-to-glb";
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
  /** The project draws with Nearest Texture Filtering: images whose names name no Usage import as Pixel Art. */
  nearestTextures: boolean;
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

/** A ZIP's importable files, before its folder exists. */
type ExpandedZipGroup = { zip: ImportFileBytes; files: ImportFileBytes[] };

/**
 * The batch's assets that hold Execute JavaScript, read before any file is written, with the bytes of
 * the files they come from (batch preparation keeps a `.hasset`'s bytes, though it may copy its entry).
 * A file that cannot be read here fails again when it imports, and is reported then.
 */
async function executeJavaScriptInBatch(
  batch: ReadonlyArray<{ file: ImportFileBytes; path: string }>,
  signal: AbortSignal,
): Promise<{ assets: ExecuteJavaScriptAsset[]; files: Set<Uint8Array> }> {
  const assets: ExecuteJavaScriptAsset[] = [];
  const files = new Set<Uint8Array>();
  for (const { file, path } of batch) {
    signal.throwIfAborted();
    let found: ExecuteJavaScriptAsset[];
    try {
      found = await executeJavaScriptInImportFile(file.name, file.bytes, path);
    } catch {
      continue;
    }
    if (found.length === 0) continue;
    assets.push(...found);
    files.add(file.bytes);
  }
  return { assets, files };
}

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
 * Expands each ZIP, keeping those that hold something to import. A ZIP that
 * cannot be read imports nothing; its error and the entries each ZIP skipped
 * go to `errors`. Nothing is written. A cancel throws.
 */
async function expandZipImports(
  zips: ImportFileBytes[],
  context: {
    signal: AbortSignal;
    errors: string[];
    onPhase: (patch: Partial<ImportProgress>) => void;
  },
): Promise<ExpandedZipGroup[]> {
  const { signal, errors, onPhase } = context;
  const expandedZips: ExpandedZipGroup[] = [];
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
    expandedZips.push({ zip, files: expanded.files });
  }
  return expandedZips;
}

/**
 * Creates each expanded ZIP's folder in the open folder (`Props.zip` →
 * `Props`, or `Props_1` when a folder of that name, in any case, exists),
 * adding one group per ZIP. A folder that cannot be made skips its ZIP, with
 * the error in `errors`.
 */
async function addZipImportGroups(
  zips: readonly ExpandedZipGroup[],
  context: {
    assetRegistry: AssetRegistry;
    selectedRoot: ContentBrowserImportFlowDeps["selectedRoot"];
    existingFolderPaths: readonly string[];
    signal: AbortSignal;
    groups: ImportGroup[];
    errors: string[];
  },
): Promise<void> {
  const { assetRegistry, selectedRoot, signal, groups, errors } = context;
  const openFolder = joinFolder(selectedRoot.pathPrefix, selectedRoot.relative);
  const folderPaths = [...context.existingFolderPaths];
  for (const { zip, files } of zips) {
    signal.throwIfAborted();
    const folder = freeFolderName(folderPaths, openFolder, zipImportFolderName(zip.name));
    try {
      await assetRegistry.createFolder(selectedRoot.rootId, joinFolder(selectedRoot.relative, folder));
    } catch (error) {
      errors.push(`${zip.name}: ${errorMessage(error)}`);
      continue;
    }
    folderPaths.push(joinAssetFolderPath(openFolder, folder));
    groups.push({ folder, files, imported: 0 });
  }
}

/**
 * Import from the toolbar, the empty grid, a shortcut or the file input,
 * behind the cancelable Importing dialog, with the errors it reports.
 */
export function useContentBrowserImportFlow(deps: ContentBrowserImportFlowDeps) {
  const { assetRegistry, selectedRoot, existingFolderPaths, play, nearestTextures, busy, setBusy, refreshAssetRegistry } = deps;
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
  /** The Execute JavaScript a batch would bring in, shown while the user decides; unmounting answers Cancel. */
  const {
    assets: executeJavaScriptReview,
    review: reviewExecuteJavaScript,
    answer: answerExecuteJavaScriptReview,
  } = useExecuteJavaScriptReview();
  /** One import at a time: one started while another runs (its dialog open included) is refused, writing nothing. */
  const importRunningRef = useRef(false);

  /**
   * Imports files behind the cancelable Importing dialog. Cancel stops the
   * file in progress (its importer, or the import worker running it) and
   * deletes the assets earlier files made, so the folder is left as it was.
   *
   * A ZIP imports into a new folder named after it (`Props.zip` → `Props`,
   * or `Props_1` when taken), keeping the folders inside it; what it skips is
   * listed with the errors. Its files form their own batch, so its models
   * find their sidecars by path.
   *
   * Before anything is written (ZIP folders included), the batch's `.hasset`
   * files are read for Execute JavaScript; when any holds some, one dialog
   * lists them, and Cancel ends the import as a cancel does.
   */
  const importPickedFiles = useCallback(
    async (
      files: Array<{ name: string; bytes: Uint8Array }>,
      controller: AbortController = new AbortController(),
    ) => {
      if (!assetRegistry || !files.length || selectedRoot.readOnly || importRunningRef.current) return;
      importRunningRef.current = true;
      try {
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
        /** The files (by their bytes) whose Execute JavaScript the user confirmed; every other file imports none. */
        let confirmedFiles = new Set<Uint8Array>();
        await runWithContentBrowserImportBusy(
          setBusy,
          () => setImportProgress(null),
          async () => {
            try {
              const zips = await expandZipImports(incoming.filter((file) => isZipFileName(file.name)), {
                signal,
                errors,
                onPhase: (patch) => updateImportProgress(signal, patch),
              });
              updateImportProgress(signal, { phase: "Checking Files", completed: 0, total: 1, fraction: null });
              const disclosed = await executeJavaScriptInBatch([
                ...groups[0]!.files.map((file) => ({ file, path: file.name })),
                ...zips.flatMap(({ zip, files }) => files.map((file) => ({ file, path: `${zip.name}/${file.name}` }))),
              ], signal);
              if (disclosed.assets.length > 0) {
                setImportProgress(null);
                if (!await reviewExecuteJavaScript(disclosed.assets)) controller.abort();
                signal.throwIfAborted();
              }
              confirmedFiles = disclosed.files;
              await addZipImportGroups(zips, {
                assetRegistry,
                selectedRoot,
                existingFolderPaths,
                signal,
                groups,
                errors,
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
                      nearestTextures,
                      sidecars: file.sidecars,
                      allowExecuteJavaScript: confirmedFiles.has(file.bytes),
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
      } finally {
        importRunningRef.current = false;
      }
    },
    [assetRegistry, existingFolderPaths, nearestTextures, play, refreshAssetRegistry, reviewExecuteJavaScript, selectedRoot, setBusy, setImportErrors, updateImportProgress],
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
    executeJavaScriptReview,
    answerExecuteJavaScriptReview,
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
