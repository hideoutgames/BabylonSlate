import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type {
  ProjectDocument,
  ProjectStorage,
  SerializedGraph,
  SerializedScene,
  SerializedSceneLayer,
} from "@haptic/core";
import { isAssetDocumentKind } from "@haptic/core";
import { truncateJournal, type MigrationPending } from "@haptic/assets";
import { journalDiscardLine } from "@haptic/edit";
import type { FileLock } from "@haptic/source-control";
import type { JournalBuffer } from "../lib/journal-buffer";
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { withEditorViewportFramesHeld } from "../lib/editor-frame-hold";
import { flushAudioReverbForSave } from "../lib/audio-reverb-bake";
import {
  flushNavBakeForSave,
} from "../lib/nav-bake-save";
import { persistableDocumentContent } from "../lib/scene-layer-document";
import { saveAllSceneWriter } from "../lib/locked-writes";
import { refreshMtimeSnapshotAfterEditorSave } from "../lib/external-change";
import type { ProjectSaveState } from "../lib/project-save-state";
import {
  EDITOR_UTILITY_EVENTS,
  emitEditorUtilityLifecycle,
} from "../lib/editor-utility-scripts";
import {
  beginSaveAllProgress,
  recordSaveAllTrace,
} from "../lib/dirty-trace";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { tileThumbnailJobs } from "../lib/tile-asset-thumbnails";
import type { DocumentService, OpenDocument } from "../services/document-service";
import type { PlayContentService } from "../services/play-content-service";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import type {
  DocumentActions,
  DocumentContextValue,
  SaveAllOutcome,
  SaveFailed,
  SaveFailedPurpose,
} from "./document-context-types";

export interface ProjectSaveDeps {
  projectService: ProjectService;
  documentService: DocumentService;
  projectDocumentRef: RefObject<ProjectDocument | null>;
  projectSaveState: RefObject<ProjectSaveState>;
  journalBuffer: JournalBuffer;
  ensureDerived: () => Promise<ProjectStorage>;
  captureAllLayouts: () => void;
  captureMtimeSnapshot: () => Promise<void>;
  playContent: PlayContentService;
  setLastCompiledSignature: (signature: string | null) => void;
  setMigrationPending: (pending: MigrationPending[]) => void;
  /** Someone else's lock refuses a document's write; it stays unsaved. */
  sourceControlRef: RefObject<SourceControlService>;
  /** Re-derives the document context value. */
  bump: () => void;
}

/**
 * Save All, auto-save and the project write queue that orders every
 * `project.json` write. Every callback keeps its identity for the provider's
 * lifetime.
 */
export function useProjectSave({
  projectService,
  documentService,
  projectDocumentRef,
  projectSaveState,
  journalBuffer,
  ensureDerived,
  captureAllLayouts,
  captureMtimeSnapshot,
  playContent,
  setLastCompiledSignature,
  setMigrationPending,
  sourceControlRef,
  bump,
}: ProjectSaveDeps) {
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Drops the pending auto-save; the next edit or resume starts a new interval. */
  const cancelDebouncedSave = useCallback(() => {
    if (!saveDebounceRef.current) return;
    clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = null;
  }, []);
  const autoSavePausedRef = useRef(false);
  /** An auto-save came due while a game covered the editor. */
  const autoSaveDeferredRef = useRef(false);
  const projectWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const enqueueProjectWrite = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = projectWriteQueue.current.then(operation);
    projectWriteQueue.current = pending.then(() => {}, () => {});
    return pending;
  }, []);
  const [autoSaveStatus, setAutoSaveStatus] = useState<DocumentContextValue["autoSaveStatus"]>(null);
  const [migrationPromptRequest, setMigrationPromptRequest] = useState(0);
  const [saveFailed, setSaveFailed] = useState<SaveFailed | null>(null);
  const dismissSaveFailed = useCallback(() => setSaveFailed(null), []);

  /**
   * The one Save All path: auto-save, Save All, Play's save and Migrate On
   * Save. Pending schema migrations refuse it until the user approves them
   * (`approveMigrations`, kept for the rest of the project session); a refused
   * Save All the user asked for (`promptMigrations`) opens the migration prompt.
   * A document someone else has locked is not written and stays unsaved
   * (`locked`); a Save All the user asked for (`reportLocked`) lists them in
   * the Save Failed prompt, while Auto-Save skips them quietly.
   */
  const runSaveAll = useCallback((options: {
    approveMigrations?: boolean;
    promptMigrations?: boolean;
    reportLocked?: SaveFailedPurpose;
  } = {}): Promise<SaveAllOutcome> => {
    // Keep the immutable authored document as the only save source. A session
    // defers new saves; an already admitted Save All retains its complete lane.
    // Refuse before queueing so a deferred save never waits behind that lane.
    const refuseLocked = () => {
      if (!projectService.authoringWriteBlockedReason) return false;
      const dirty = documentService.getDirtyDocuments().length + Number(projectSaveState.current.isDirty(projectDocumentRef.current));
      recordSaveAllTrace({ ok: false, reason: "authoring-locked", dirtyBefore: dirty, dirtyAfter: dirty });
      return true;
    };
    if (refuseLocked()) return Promise.resolve("authoring-locked");
    // Each await below resumes only after any editor viewport frame drawn
    // meanwhile, so the viewports hold their frames until this save settles.
    return enqueueProjectWrite(() => withEditorViewportFramesHeld(async (): Promise<SaveAllOutcome> => {
    if (refuseLocked()) return "authoring-locked";
    return projectService.withBaselineSave(async (admitted): Promise<SaveAllOutcome> => {
      const progress = beginSaveAllProgress();
      const document = projectDocumentRef.current;
      const guid = projectService.guid;
      const dirtyBefore = documentService.getDirtyDocuments().length + Number(projectSaveState.current.isDirty(document));
      if (!document) {
        recordSaveAllTrace({
          ok: false,
          reason: "no-document",
          dirtyBefore,
          dirtyAfter: dirtyBefore,
        });
        progress.finish();
        return "no-document";
      }
      const migrate = options.approveMigrations === true || projectService.migrationsApproved;
      if (!migrate && projectService.pendingMigrations.length > 0) {
        setMigrationPending(projectService.pendingMigrations);
        if (options.promptMigrations) setMigrationPromptRequest((request) => request + 1);
        recordSaveAllTrace({
          ok: false,
          reason: "migrations",
          dirtyBefore,
          dirtyAfter: dirtyBefore,
        });
        progress.finish();
        // Never silently rewrite: the user approves through the migration prompt.
        return "migrations";
      }
      if (options.approveMigrations) projectService.approveMigrateOnSave();
      cancelDebouncedSave();
      // Buffered journal records start writing as Save begins, so a Save that
      // fails part-way leaves them recoverable. The clear below awaits them.
      void journalBuffer.flush();
      const projectSave = projectSaveState.current.capture(document);
      // Someone else's lock, read once per path for the whole save: its file
      // is never written, bakes included, and its document stays unsaved.
      const sourceControl = sourceControlRef.current;
      const lockChecks = new Map<string, FileLock | null>();
      const lockedByOther = (path: string) => {
        if (!lockChecks.has(path)) lockChecks.set(path, sourceControl.lockedByOther(path));
        return lockChecks.get(path)!;
      };
      const writer = saveAllSceneWriter(admitted, lockedByOther);
      try {
        progress.phase("audio-reverb");
        await flushAudioReverbForSave(undefined, writer);
        progress.phase("navigation");
        await flushNavBakeForSave(writer);
        captureAllLayouts();
        const dirtyDocs = documentService.getDirtyDocuments().map((doc) => ({ ...doc }));
        const blocked = dirtyDocs.flatMap((doc) => {
          const lock = lockedByOther(doc.ref.path);
          return lock ? [{ doc, lock }] : [];
        });
        // Everything after the writes uses only what this save wrote.
        const saved: OpenDocument[] = blocked.length
          ? dirtyDocs.filter((doc) => !blocked.some((entry) => entry.doc.id === doc.id))
          : dirtyDocs;
        const savedScene = saved.some((doc) => doc.ref.kind === "scene");
        const savedModels = saved.filter((doc) => doc.ref.kind === "model" || doc.ref.kind === "animation");
        progress.phase("documents");
        for (const doc of saved) {
          // A Content Browser delete or move between two saves leaves this
          // snapshot's path behind; writing it would bring the file back.
          // `markAllClean` skips the same documents, so a moved one stays dirty.
          const live = documentService.getDocument(doc.id);
          if (!live || live.ref.path !== doc.ref.path) continue;
          if (
            isAssetDocumentKind(doc.ref.kind) &&
            doc.ref.kind !== "trace" &&
            doc.content
          ) {
            await writer.saveDocument(
              doc.ref.kind,
              doc.ref.path,
              persistableDocumentContent(doc.ref.kind, doc.content) as
                | SerializedScene
                | SerializedSceneLayer
                | SerializedGraph
                | Record<string, unknown>,
            );
          }
        }
        progress.phase("compile");
        if (document.settings.compileOnSave) {
          setLastCompiledSignature(playContent.compileOpenGraphs(document.settings.tags));
        }
        const layouts = documentService.buildLayouts();
        progress.phase("project");
        await writer.saveProject(document, layouts);
        documentService.markAllClean(saved);
        setMigrationPending([]);
        if (guid && documentService.getDirtyDocuments().length > 0) {
          // The journal is cleared only once nothing is unsaved: until then it
          // must not replay what this save wrote onto the saved files.
          const at = new Date().toISOString();
          for (const doc of saved) {
            if (documentService.getDocument(doc.id)?.dirty === false) journalBuffer.append(guid, journalDiscardLine(doc.id, at));
          }
        }
        progress.phase("mtime");
        await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
        if (guid) {
          progress.phase("journal");
          const derived = await ensureDerived();
          // The journal holds document edits only; Project Settings changed
          // during the save are not in it and must not keep saved edits there.
          // Records sealed for a pending recovery stay.
          await journalBuffer.clearAfterFlush(guid, () =>
            truncateJournal(derived, guid, () =>
              projectService.guid === guid && documentService.getDirtyDocuments().length === 0,
            ),
          );
        }
        progress.phase("callbacks");
        if (savedScene) {
          emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.sceneSaved);
        }
        enqueueModelThumbnailJobs(
          savedModels.flatMap((doc) => {
            const guid = projectService.guidForPath(doc.ref.path);
            if (!guid || !doc.content) return [];
            return [
              {
                guid,
                path: doc.ref.path,
                payload: doc.content as Record<string, unknown>,
                type: doc.ref.kind === "animation" ? "Animation" as const : "Model" as const,
              },
            ];
          }),
        );
        // Saved Tilesets and Tilemaps draw again, and so do those showing a saved Texture or Tileset.
        const registry = projectService.registry;
        if (guid && registry) {
          const savedGuids = saved.flatMap((doc) => projectService.guidForPath(doc.ref.path) ?? []);
          void tileThumbnailJobs(registry.list(), savedGuids, guid, document.settings.twoD.pixelsPerUnit)
            .then(enqueueModelThumbnailJobs)
            // A thumbnail that cannot be queued keeps the type icon.
            .catch(() => undefined);
        }
        projectSaveState.current.complete(projectSave);
        setAutoSaveStatus(null);
        const purpose = options.reportLocked;
        if (blocked.length > 0 && purpose) {
          setSaveFailed({
            purpose,
            documents: blocked.map(({ doc, lock }) => ({ id: doc.id, path: doc.ref.path, label: doc.ref.label, holder: lock.ownerName })),
          });
        }
        flushSync(() => {
          bump();
        });
        recordSaveAllTrace({
          ok: blocked.length === 0,
          reason: blocked.length === 0 ? "saved" : "locked",
          dirtyBefore,
          dirtyAfter: documentService.getDirtyDocuments().length + Number(projectSaveState.current.isDirty(projectDocumentRef.current)),
        });
        return blocked.length === 0 ? "saved" : "locked";
      } catch (error) {
        recordSaveAllTrace({
          ok: false,
          reason: "error",
          dirtyBefore,
          dirtyAfter: documentService.getDirtyDocuments().length + Number(projectSaveState.current.isDirty(projectDocumentRef.current)),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        progress.finish();
      }
    });
    }));
  }, [
    cancelDebouncedSave,
    enqueueProjectWrite,
    bump,
    captureAllLayouts,
    captureMtimeSnapshot,
    documentService,
    ensureDerived,
    journalBuffer,
    playContent,
    projectService,
    projectDocumentRef,
    projectSaveState,
    setLastCompiledSignature,
    setMigrationPending,
    sourceControlRef,
  ]);
  /**
   * Auto-save: a refusal pauses it with a status message, never a prompt, and
   * documents someone else has locked are skipped quietly.
   */
  const saveProject = useCallback(() => runSaveAll(), [runSaveAll]);
  /**
   * Save All the user asked for: a refusal for pending migrations opens the
   * prompt, and documents someone else has locked are listed in Save Failed.
   */
  const saveAll = useCallback((purpose: SaveFailedPurpose = "save") =>
    runSaveAll({ promptMigrations: true, reportLocked: purpose }), [runSaveAll]);
  /** Migrate On Save: approve the pending migrations and run the complete Save All. */
  const approveMigrationsAndSave = useCallback((purpose: SaveFailedPurpose = "save") =>
    runSaveAll({ approveMigrations: true, reportLocked: purpose }), [runSaveAll]);

  const scheduleDebouncedSave = useCallback(() => {
    // Auto-Save off: nothing saves on its own, and an interval already waiting
    // is dropped (turning it off is itself a settings change that lands here).
    // Turning it on again lands here too and starts a new interval.
    const autoSaveOff = () => projectDocumentRef.current?.settings.autoSave === false;
    if (autoSaveOff()) {
      cancelDebouncedSave();
      return;
    }
    if (saveDebounceRef.current || autoSavePausedRef.current) return;
    const interval =
      projectDocumentRef.current?.settings.autoSaveIntervalMs ?? 120_000;
    saveDebounceRef.current = setTimeout(() => {
      saveDebounceRef.current = null;
      // Turned off another way meanwhile (a reloaded project.json).
      if (autoSaveOff()) return;
      // A game covers the editor: the save waits for it, then a fresh interval.
      if (editorQuiet()) {
        autoSaveDeferredRef.current = true;
        return;
      }
      const guid = projectService.guid;
      setAutoSaveStatus({ state: "saving" });
      void saveProject().then(
        (outcome) => {
          if (projectService.guid !== guid) return;
          // Documents someone else has locked stay unsaved without a word: Save All names them.
          setAutoSaveStatus(outcome === "saved" || outcome === "locked"
            ? { state: "saved" }
            : { state: "error", message: "Auto-Save Paused. Use Save All to review the pending changes." });
        },
        (error: unknown) => {
          if (projectService.guid !== guid) return;
          setAutoSaveStatus({
            state: "error",
            message: `Auto-Save Failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
    }, interval);
  }, [cancelDebouncedSave, projectService, saveProject, projectDocumentRef]);

  const setAutoSavePaused = useCallback((paused: boolean) => {
    if (autoSavePausedRef.current === paused) return;
    autoSavePausedRef.current = paused;
    if (paused) {
      cancelDebouncedSave();
    } else if (
      projectService.guid &&
      (documentService.getDirtyDocuments().length > 0 || projectSaveState.current.isDirty(projectDocumentRef.current))
    ) {
      scheduleDebouncedSave();
    }
  }, [cancelDebouncedSave, documentService, projectService, scheduleDebouncedSave, projectDocumentRef, projectSaveState]);

  useEffect(() => subscribeEditorQuiet(() => {
    if (editorQuiet() || !autoSaveDeferredRef.current) return;
    autoSaveDeferredRef.current = false;
    if (
      projectService.guid &&
      (documentService.getDirtyDocuments().length > 0 || projectSaveState.current.isDirty(projectDocumentRef.current))
    ) {
      scheduleDebouncedSave();
    }
  }), [documentService, projectService, scheduleDebouncedSave, projectDocumentRef, projectSaveState]);

  /**
   * Writes `project.json` now, in the project write queue: a Save All already
   * running finishes first instead of overwriting it with its older document.
   */
  const saveProjectNow = useCallback((next: ProjectDocument) => enqueueProjectWrite(async () => {
    const projectSave = projectSaveState.current.capture(next);
    await projectService.saveProject(next, documentService.buildLayouts());
    await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
    projectSaveState.current.complete(projectSave);
  }), [captureMtimeSnapshot, documentService, enqueueProjectWrite, projectService, projectSaveState]);

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "saveProject"
      | "saveAll"
      | "approveMigrationsAndSave"
      | "setAutoSavePaused"
      | "dismissSaveFailed"
    > => ({
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      setAutoSavePaused,
      dismissSaveFailed,
    }),
    [
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      setAutoSavePaused,
      dismissSaveFailed,
    ],
  );

  return {
    autoSaveStatus,
    setAutoSaveStatus,
    saveFailed,
    dismissSaveFailed,
    migrationPromptRequest,
    cancelDebouncedSave,
    enqueueProjectWrite,
    scheduleDebouncedSave,
    saveAll,
    saveProjectNow,
    actions,
  };
}
