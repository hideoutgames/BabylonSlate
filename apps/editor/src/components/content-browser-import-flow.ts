import { useCallback, useRef, useState } from "react";
import {
  embedGltfImportBatch,
  groupMsdfImportBatch,
  pickerImportAccept,
  type AssetRegistry,
} from "@haptic/assets";
import { convertObjImportBatch, convertStlImportBatch } from "@haptic/render";
import { convertFbxImportBatch } from "@haptic/render/fbx-import";
import { createAppSettingsStore, isMobilePlatform, pickImportFiles } from "@haptic/vfs";
import type { useDocumentActions } from "../context/document-context";
import type { useOptionalPlay } from "../context/play-context";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { runWithContentBrowserImportBusy } from "../lib/content-browser-helpers";
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
  /** Its shared Engine converts OBJ and STL models. */
  play: ReturnType<typeof useOptionalPlay>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

/**
 * Import from the toolbar, the empty grid, a shortcut or the file input,
 * behind the cancelable Importing dialog, with the errors it reports.
 */
export function useContentBrowserImportFlow(deps: ContentBrowserImportFlowDeps) {
  const { assetRegistry, selectedRoot, play, busy, setBusy, refreshAssetRegistry } = deps;
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
      const conversion = {
        signal,
        onFile: (name: string) => updateImportProgress(signal, { phase: `Converting ${name}`, completed: 0, total: 1, fraction: null }),
      };
      const createdModels: Array<{
        guid: string;
        path: string;
        payload: Record<string, unknown>;
        type: "Model" | "Animation";
      }> = [];
      await runWithContentBrowserImportBusy(
        setBusy,
        () => setImportProgress(null),
        async () => {
          try {
            const fbx = await convertFbxImportBatch(incoming, conversion);
            errors.push(...fbx.errors);
            const { files: converted, errors: convertErrors } =
              await convertObjImportBatch(fbx.files, {
                ...conversion,
                engine: play?.ensureSharedEngine() ?? undefined,
              });
            errors.push(...convertErrors);
            const stl = await convertStlImportBatch(converted, {
              ...conversion,
              engine: play?.ensureSharedEngine() ?? undefined,
            });
            errors.push(...stl.errors);
            const embedded = embedGltfImportBatch(stl.files);
            errors.push(...embedded.warnings);
            const prepared = groupMsdfImportBatch(
              embedded.files.filter((file) => !fbx.consumedSidecars.includes(file.name)),
            );
            if (prepared.length === 0) return;
            const folder = selectedRoot.relative;
            const { modelImportDefaultScale, hdrImportFaceSize } = await createAppSettingsStore().load();
            for (let index = 0; index < prepared.length; index += 1) {
              signal.throwIfAborted();
              const file = prepared[index]!;
              updateImportProgress(signal, { phase: file.name, completed: index, total: prepared.length, fraction: null });
              try {
                const created = await assetRegistry.importFile(
                  selectedRoot.rootId,
                  folder,
                  file.name,
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
                errors.push(
                  `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              updateImportProgress(signal, { completed: index + 1, fraction: null });
            }
          } catch (err) {
            if (!signal.aborted) errors.push(err instanceof Error ? err.message : String(err));
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
    [assetRegistry, play, refreshAssetRegistry, selectedRoot, setBusy, setImportErrors, updateImportProgress],
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
