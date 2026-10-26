import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type {
  DocumentRef,
  ProjectDocument,
  ProjectFolderHandle,
  ProjectMetadata,
  ProjectStorage,
} from "@haptic/core";
import {
  discardSealedJournal,
  readSealedJournalLines,
  sealJournalForRecovery,
  truncateJournal,
  type MigrationPending,
  type ProjectTemplateCatalogEntry,
} from "@haptic/assets";
import { resolveJournalLines, type EditSession } from "@haptic/edit";
import { waitForSceneLoadingPaint } from "../lib/scene-viewport-load";
import type { JournalBuffer } from "../lib/journal-buffer";
import { ensureEnginePluginStorage } from "../lib/engine-plugins";
import { ensureEngineExtensionStorage } from "../lib/engine-extensions";
import { ensureEngineExtensionLibrary } from "../lib/engine-extension-library";
import { ensureEnginePluginLibrary } from "../lib/engine-plugin-library";
import type { CreateProjectOptions } from "../lib/create-project";
import { editorKtx2PublicBase } from "../lib/public-engine-assets";
import type { ProjectSaveState } from "../lib/project-save-state";
import {
  EDITOR_UTILITY_EVENTS,
  emitEditorUtilityLifecycle,
} from "../lib/editor-utility-scripts";
import type { AnimEditorMode } from "../shell/anim-document-layout";
import type { DocumentEditingService } from "../services/document-editing-service";
import type { DocumentService } from "../services/document-service";
import type { DocumentTransitionGate } from "../services/document-transition-gate";
import type { PlayContentService } from "../services/play-content-service";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import { loadSelectedTemplateFiles } from "../services/template-service";
import type {
  AppRoute,
  CloseProjectResult,
  DocumentActions,
  DocumentContextValue,
} from "./document-context-types";

/**
 * Opening or closing a project resets every subsystem, so this lists what
 * each one gives the lifecycle.
 */
export interface ProjectLifecycleDeps {
  // Services.
  projectService: ProjectService;
  documentService: DocumentService;
  documentTransitions: DocumentTransitionGate;
  editSessionRef: RefObject<EditSession>;
  sourceControlRef: RefObject<SourceControlService>;
  journalBuffer: JournalBuffer;
  ensureDerived: () => Promise<ProjectStorage>;
  editing: DocumentEditingService;
  // Provider state.
  /** Re-derives the document context value. */
  bump: () => void;
  projectDocumentRef: RefObject<ProjectDocument | null>;
  projectSaveState: RefObject<ProjectSaveState>;
  setProjectDocument: (document: ProjectDocument | null) => void;
  setRoute: (route: AppRoute) => void;
  setMigrationPending: (pending: MigrationPending[]) => void;
  setRecoveryAvailable: (available: boolean) => void;
  setDocumentOpenError: (error: string | null) => void;
  // The Loading Document slot.
  sceneDocumentLoad: { ref: DocumentRef; failed: boolean; error?: unknown } | null;
  sceneDocumentLoadRef: RefObject<AbortController | null>;
  setSceneDocumentLoad: (load: { ref: DocumentRef; failed: boolean; error?: unknown } | null) => void;
  cancelSceneDocumentLoad: () => void;
  // Dock layouts.
  resetDockLayouts: () => void;
  setAnimEditorModes: (modes: Record<string, AnimEditorMode>) => void;
  captureAllLayouts: () => void;
  // Compile.
  setLastCompiledSignature: (signature: string | null) => void;
  playContent: PlayContentService;
  // Thumbnails.
  resetThumbnails: () => void;
  // Project list.
  recordRecent: (
    handle: ProjectFolderHandle | null,
    metadata: ProjectMetadata,
    sourceControl: boolean,
  ) => Promise<void>;
  refreshProjectList: () => Promise<void>;
  setNeedsReconnect: (needsReconnect: boolean) => void;
  templatesRef: RefObject<ProjectTemplateCatalogEntry[]>;
  // External changes.
  captureMtimeSnapshot: () => Promise<void>;
  resetExternalChanges: () => void;
  // Save.
  setAutoSaveStatus: (status: DocumentContextValue["autoSaveStatus"]) => void;
  cancelDebouncedSave: () => void;
  enqueueProjectWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  // Tabs.
  cancelExclusiveSceneOpen: () => void;
}

/**
 * Opening, creating, reconnecting and closing a project, and the recovery
 * offer for edits an earlier session journalled but never saved. Every
 * callback keeps its identity for the provider's lifetime.
 */
export function useProjectLifecycle({
  projectService,
  documentService,
  documentTransitions,
  editSessionRef,
  sourceControlRef,
  journalBuffer,
  ensureDerived,
  editing,
  bump,
  projectDocumentRef,
  projectSaveState,
  setProjectDocument,
  setRoute,
  setMigrationPending,
  setRecoveryAvailable,
  setDocumentOpenError,
  sceneDocumentLoad,
  sceneDocumentLoadRef,
  setSceneDocumentLoad,
  cancelSceneDocumentLoad,
  resetDockLayouts,
  setAnimEditorModes,
  captureAllLayouts,
  setLastCompiledSignature,
  playContent,
  resetThumbnails,
  recordRecent,
  refreshProjectList,
  setNeedsReconnect,
  templatesRef,
  captureMtimeSnapshot,
  resetExternalChanges,
  setAutoSaveStatus,
  cancelDebouncedSave,
  enqueueProjectWrite,
  cancelExclusiveSceneOpen,
}: ProjectLifecycleDeps) {
  const [recoveryRequested, setRecoveryRequested] = useState(false);

  const enterEditor = useCallback(
    async (
      document: ProjectDocument,
      layouts: Awaited<
        ReturnType<ProjectService["loadCurrentProject"]>
      >["layouts"],
      pending: MigrationPending[] = [],
    ) => {
      cancelSceneDocumentLoad();
      const sceneLoadController = new AbortController();
      sceneDocumentLoadRef.current = sceneLoadController;
      resetDockLayouts();
      editSessionRef.current.clear();
      resetThumbnails();
      try {
        await documentService.initializeFromProject(
          projectService,
          document,
          layouts,
          {
            signal: sceneLoadController.signal,
            beforeLoad: async (ref) => {
              setSceneDocumentLoad({ ref, failed: false });
              await waitForSceneLoadingPaint(sceneLoadController.signal);
            },
          },
        );
      } finally {
        if (sceneDocumentLoadRef.current === sceneLoadController) {
          sceneDocumentLoadRef.current = null;
          setSceneDocumentLoad(null);
        }
      }
      projectSaveState.current.reset(document);
      setProjectDocument(document);
      setMigrationPending(pending);
      setLastCompiledSignature(null);
      playContent.clearCompileCache();
      // A reload as soon as editing starts must still find this project on Homepage.
      await recordRecent(
        projectService.storagePort.getCurrentFolder(),
        document.metadata,
        document.settings.sourceControl?.enabled === true,
      );
      // Records from a session that never saved them wait for Recover or
      // Discard; this session's saves and closes only truncate what it writes.
      // Sealed before the editor shows, so its first edits are never offered.
      const derived = await ensureDerived();
      const guid = projectService.guid;
      if (guid) {
        await sealJournalForRecovery(derived, guid);
        const unreplayed = resolveJournalLines(await readSealedJournalLines(derived, guid));
        if (unreplayed.length === 0) await discardSealedJournal(derived, guid);
        setRecoveryAvailable(unreplayed.length > 0);
      }
      setRoute("editor");
      setAnimEditorModes({});
      const { probeKtx2TranscoderAvailable } = await import(
        "@haptic/render/ktx2-transcoder"
      );
      const transcoderOk = await probeKtx2TranscoderAvailable(
        editorKtx2PublicBase(),
      );
      await projectService.setTranscoderAvailable(transcoderOk);
      projectService.setDerivedStorage(derived);
      await refreshProjectList();
      await captureMtimeSnapshot();
      bump();
    },
    [
      bump,
      documentService,
      ensureDerived,
      projectService,
      recordRecent,
      resetDockLayouts,
      refreshProjectList,
      captureMtimeSnapshot,
      cancelSceneDocumentLoad,
      playContent,
      setAnimEditorModes,
      setProjectDocument,
      editSessionRef,
      projectSaveState,
      resetThumbnails,
      sceneDocumentLoadRef,
      setLastCompiledSignature,
      setMigrationPending,
      setRecoveryAvailable,
      setRoute,
      setSceneDocumentLoad,
    ],
  );

  const attachEnginePlugins = useCallback(async (forNewProject = false) => {
    const storage = forNewProject
      ? await (await ensureEnginePluginLibrary()).createStorageSnapshot()
      : await ensureEnginePluginStorage();
    projectService.setEnginePluginStorage(storage);
    projectService.setEngineExtensionStorage(forNewProject
      ? await (await ensureEngineExtensionLibrary()).createStorageSnapshot()
      : await ensureEngineExtensionStorage());
  }, [projectService]);

  const openProject = useCallback(async (source?: "folder" | "zip") => {
    if (!await documentTransitions.check({ kind: "replace-project" })) return;
    await attachEnginePlugins();
    try {
      const result = await projectService.openProject(source);
      if (!result) return;
      const { document, layouts, migrationPending: pending } = result;
      await enterEditor(document, layouts, pending);
    } finally {
      setNeedsReconnect(await projectService.needsReconnect());
    }
  }, [attachEnginePlugins, enterEditor, projectService, documentTransitions, setNeedsReconnect]);

  const createEmptyProject = useCallback(
    async (name: string, options?: CreateProjectOptions) => {
      if (!await documentTransitions.check({ kind: "replace-project" })) return;
      await attachEnginePlugins(true);
      const { document, layouts, migrationPending: pending } =
        await projectService.createEmptyProject(name, options);
      await enterEditor(document, layouts, pending);
    },
    [attachEnginePlugins, enterEditor, projectService, documentTransitions],
  );

  const createFromTemplate = useCallback(
    async (
      templateId: string,
      name: string,
      options?: CreateProjectOptions,
    ) => {
      const template = templatesRef.current.find((t) => t.id === templateId);
      if (!template) {
        throw new Error(`Unknown template: ${templateId}`);
      }
      if (!await documentTransitions.check({ kind: "replace-project" })) return;
      await attachEnginePlugins(true);
      const { document, layouts, migrationPending: pending } =
        await projectService.createFromTemplate({
          templateFiles: await loadSelectedTemplateFiles(template.id),
          name,
          pickFolder: options?.pickFolder,
          appearance: options?.appearance,
        });
      await enterEditor(document, layouts, pending);
    },
    [attachEnginePlugins, enterEditor, projectService, documentTransitions, templatesRef],
  );

  const openListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      if (!await documentTransitions.check({ kind: "replace-project" })) return;
      await attachEnginePlugins();
      try {
        const { document, layouts, migrationPending: pending } =
          await projectService.openListedProject(handle);
        await enterEditor(document, layouts, pending);
      } finally {
        setNeedsReconnect(await projectService.needsReconnect());
      }
    },
    [attachEnginePlugins, enterEditor, projectService, documentTransitions, setNeedsReconnect],
  );

  const reconnectProject = useCallback(async () => {
    await attachEnginePlugins();
    try {
      const { document, layouts, migrationPending: pending } =
        await projectService.reconnect();
      await enterEditor(document, layouts, pending);
    } finally {
      setNeedsReconnect(await projectService.needsReconnect());
    }
  }, [attachEnginePlugins, enterEditor, projectService, setNeedsReconnect]);

  const releaseSessionsForProjectClose = useCallback(
    async () => documentTransitions.check({ kind: "close-project" }),
    [documentTransitions],
  );

  /** Close Project's prompt when documents or project settings are unsaved. */
  const unsavedProjectWork = useCallback((): CloseProjectResult | null => {
    const dirty = documentService.getDirtyDocuments();
    const projectDirty = projectSaveState.current.isDirty(projectDocumentRef.current);
    return dirty.length > 0 || projectDirty ? { outcome: "unsaved", dirty, projectDirty } : null;
  }, [documentService, projectDocumentRef, projectSaveState]);

  /**
   * `clean`: the close keeps no unsaved work. It writes tabs, dock layouts and
   * panel placements, which Save would have, and returns unsaved work a
   * stopping session left behind (Simulation's Keep Changes) instead of
   * discarding it. Otherwise the close discards unsaved work.
   */
  const shutDownProject = useCallback(async (clean: boolean): Promise<CloseProjectResult> => {
    setAutoSaveStatus(null);
    if (!await documentTransitions.check({ kind: "close-project" })) return { outcome: "refused" };
    const unsaved = clean ? unsavedProjectWork() : null;
    if (unsaved) return unsaved;
    documentService.assertAuthoringWritable();
    cancelSceneDocumentLoad();
    cancelExclusiveSceneOpen();
    cancelDebouncedSave();
    // A Save All or rename already admitted finishes before the journal is
    // cleared and the folder released; later queued saves find no project.
    await enqueueProjectWrite(async () => {
      cancelDebouncedSave();
      if (clean && !projectService.authoringWriteBlockedReason) {
        captureAllLayouts();
        // Layout is a convenience: a failed write must not keep the project open.
        await projectService.saveLayouts(documentService.buildLayouts()).catch((error: unknown) => {
          console.warn("[editor] Could not keep the layout when closing the project", error);
        });
      }
      const guid = projectService.guid;
      if (guid) {
        const derived = await ensureDerived();
        await journalBuffer.clearAfterFlush(guid, () => truncateJournal(derived, guid));
      }
      emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.shutdown);
      await projectService.closeProject();
    });
    sourceControlRef.current.dispose();
    projectService.setDerivedStorage(null);
    resetDockLayouts();
    editSessionRef.current.clear();
    documentService.ensureContentBrowserTab();
    projectSaveState.current.reset(null);
    setProjectDocument(null);
    setRecoveryAvailable(false);
    setMigrationPending([]);
    setLastCompiledSignature(null);
    playContent.clearCompileCache();
    setRoute("home");
    setAnimEditorModes({});
    resetExternalChanges();
    setDocumentOpenError(null);
    await refreshProjectList();
    bump();
    return { outcome: "closed" };
  }, [
    cancelDebouncedSave,
    bump,
    captureAllLayouts,
    documentService,
    enqueueProjectWrite,
    ensureDerived,
    journalBuffer,
    projectService,
    refreshProjectList,
    cancelSceneDocumentLoad,
    playContent,
    resetDockLayouts,
    setAnimEditorModes,
    setProjectDocument,
    documentTransitions,
    unsavedProjectWork,
    cancelExclusiveSceneOpen,
    editSessionRef,
    projectSaveState,
    resetExternalChanges,
    setAutoSaveStatus,
    setDocumentOpenError,
    setLastCompiledSignature,
    setMigrationPending,
    setRecoveryAvailable,
    setRoute,
    sourceControlRef,
  ]);

  const forceCloseProject = useCallback(
    async () => (await shutDownProject(false)).outcome === "closed",
    [shutDownProject],
  );

  // Unsaved work prompts first: a running session stops only once the user
  // chooses Save All or Discard, so Cancel leaves it running.
  const closeProject = useCallback(
    async (): Promise<CloseProjectResult> => unsavedProjectWork() ?? shutDownProject(true),
    [shutDownProject, unsavedProjectWork],
  );

  const dismissRecovery = useCallback(async () => {
    const guid = projectService.guid;
    if (guid) {
      // Edits made since the project opened are not part of the offer and stay.
      await discardSealedJournal(await ensureDerived(), guid);
    }
    // The banner belongs to the project open now; another may have opened meanwhile.
    if (projectService.guid === guid) setRecoveryAvailable(false);
  }, [ensureDerived, projectService, setRecoveryAvailable]);

  const keepRecovery = useCallback(() => {
    setRecoveryRequested(true);
  }, []);

  // A scene read replaces the current scene at commit. Replay only after that
  // read settles, so it cannot close the scene we have just recovered.
  useEffect(() => {
    if (!recoveryRequested || sceneDocumentLoad) return;
    setRecoveryRequested(false);
    void editing.replayRecoveryJournal();
  }, [editing, recoveryRequested, sceneDocumentLoad]);

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "openProject"
      | "createEmptyProject"
      | "createFromTemplate"
      | "openListedProject"
      | "reconnectProject"
      | "closeProject"
      | "releaseSessionsForProjectClose"
      | "forceCloseProject"
      | "dismissRecovery"
      | "keepRecovery"
    > => ({
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      reconnectProject,
      closeProject,
      releaseSessionsForProjectClose,
      forceCloseProject,
      dismissRecovery,
      keepRecovery,
    }),
    [
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      reconnectProject,
      closeProject,
      releaseSessionsForProjectClose,
      forceCloseProject,
      dismissRecovery,
      keepRecovery,
    ],
  );

  return { actions };
}
