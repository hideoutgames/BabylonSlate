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
import type { JournalBuffer } from "../lib/journal-buffer";
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { withEditorViewportFramesHeld } from "../lib/editor-frame-hold";
import { flushAudioReverbForSave } from "../lib/audio-reverb-bake";
import {
  flushNavBakeForSave,
} from "../lib/nav-bake-save";
import { persistableDocumentContent } from "../lib/scene-layer-document";
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
import type { DocumentService } from "../services/document-service";
import type { PlayContentService } from "../services/play-content-service";
import type { ProjectService } from "../services/project-service";
import type { DocumentActions, DocumentContextValue } from "./document-context-types";

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

  /**
   * The one Save All path: auto-save, Save All, Play's save and Migrate On
   * Save. Pending schema migrations refuse it until the user approves them
   * (`approveMigrations`, kept for the rest of the project session); a refused
   * Save All the user asked for (`promptMigrations`) opens the migration prompt.
   */
  const runSaveAll = useCallback((options: { approveMigrations?: boolean; promptMigrations?: boolean } = {}): Promise<boolean> => {
    // Keep the immutable authored document as the only save source. A session
    // defers new saves; an already admitted Save All retains its complete lane.
    // Refuse before queueing so a deferred save never waits behind that lane.
    const refuseLocked = () => {
      if (!projectService.authoringWriteBlockedReason) return false;
      const dirty = documentService.getDirtyDocuments().length + Number(projectSaveState.current.isDirty(projectDocumentRef.current));
      recordSaveAllTrace({ ok: false, reason: "authoring-locked", dirtyBefore: dirty, dirtyAfter: dirty });
      return true;
    };
    if (refuseLocked()) return Promise.resolve(false);
    // Each await below resumes only after any editor viewport frame drawn
    // meanwhile, so the viewports hold their frames until this save settles.
    return enqueueProjectWrite(() => withEditorViewportFramesHeld(async () => {
    if (refuseLocked()) return false;
    return projectService.withBaselineSave(async writer => {
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
        return false;
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
        return false;
      }
      if (options.approveMigrations) projectService.approveMigrateOnSave();
      cancelDebouncedSave();
      // Buffered journal records start writing as Save begins, so a Save that
      // fails part-way leaves them recoverable. The clear below awaits them.
      void journalBuffer.flush();
      const projectSave = projectSaveState.current.capture(document);
      try {
        progress.phase("audio-reverb");
        await flushAudioReverbForSave(undefined, writer);
        progress.phase("navigation");
        await flushNavBakeForSave(writer);
        captureAllLayouts();
        const dirtyDocs = documentService.getDirtyDocuments().map((doc) => ({ ...doc }));
        const savedScene = dirtyDocs.some((doc) => doc.ref.kind === "scene");
        const savedModels = dirtyDocs.filter((doc) => doc.ref.kind === "model" || doc.ref.kind === "animation");
        progress.phase("documents");
        for (const doc of dirtyDocs) {
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
        documentService.markAllClean(dirtyDocs);
        setMigrationPending([]);
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
        projectSaveState.current.complete(projectSave);
        setAutoSaveStatus(null);
        flushSync(() => {
          bump();
        });
        recordSaveAllTrace({
          ok: true,
          reason: "saved",
          dirtyBefore,
          dirtyAfter: documentService.getDirtyDocuments().length + Number(projectSaveState.current.isDirty(projectDocumentRef.current)),
        });
        return true;
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
  ]);
  /** Auto-save: a refusal pauses it with a status message, never a prompt. */
  const saveProject = useCallback(() => runSaveAll(), [runSaveAll]);
  /** Save All the user asked for: a refusal for pending migrations opens the prompt. */
  const saveAll = useCallback(() => runSaveAll({ promptMigrations: true }), [runSaveAll]);
  /** Migrate On Save: approve the pending migrations and run the complete Save All. */
  const approveMigrationsAndSave = useCallback(() => runSaveAll({ approveMigrations: true }), [runSaveAll]);

  const scheduleDebouncedSave = useCallback(() => {
    if (saveDebounceRef.current || autoSavePausedRef.current) return;
    const interval =
      projectDocumentRef.current?.settings.autoSaveIntervalMs ?? 120_000;
    saveDebounceRef.current = setTimeout(() => {
      saveDebounceRef.current = null;
      // A game covers the editor: the save waits for it, then a fresh interval.
      if (editorQuiet()) {
        autoSaveDeferredRef.current = true;
        return;
      }
      const guid = projectService.guid;
      setAutoSaveStatus({ state: "saving" });
      void saveProject().then(
        (saved) => {
          if (projectService.guid !== guid) return;
          setAutoSaveStatus(saved
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
  }, [projectService, saveProject, projectDocumentRef]);

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
    > => ({
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      setAutoSavePaused,
    }),
    [
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      setAutoSavePaused,
    ],
  );

  return {
    autoSaveStatus,
    setAutoSaveStatus,
    migrationPromptRequest,
    cancelDebouncedSave,
    enqueueProjectWrite,
    scheduleDebouncedSave,
    saveAll,
    saveProjectNow,
    actions,
  };
}
