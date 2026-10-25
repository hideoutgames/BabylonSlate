import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SceneLoadingDialog } from "../components/scene-loading-dialog";
import { DocumentOpenErrorDialog } from "../components/document-open-error-dialog";
import type {
  DocumentRef,
  ProjectDocument,
} from "@haptic/core";
import { normalizeProjectSettings, remapAlwaysPackageFolders } from "@haptic/core";
import {
  appendJournalLines,
  type AssetLoadScope,
  type AssetLoadPriority,
  type MigrationPending,
} from "@haptic/assets";
import {
  DEFAULT_EDIT_BYTE_BUDGET,
  EditSession,
} from "@haptic/edit";
import { attachJournalFlushOnHide, JournalBuffer } from "../lib/journal-buffer";
import {
  createAppSettingsStore,
  createDerivedStorage,
  createStorage,
  isTestModeEnabled,
  ENGINE_SETTINGS_CHANGED_EVENT,
  type EngineSettings,
} from "@haptic/vfs";
import type { ProjectStorage } from "@haptic/core";
import {
  DocumentService,
  documentKindsRevision,
  type DocumentIdentityListener,
} from "../services/document-service";
import { DocumentEditingService } from "../services/document-editing-service";
import { createPlayContentService, GRAPH_SIGNATURE_KINDS } from "../services/play-content-service";
import { attachEditGestureBoundaries } from "../services/edit-gesture-boundaries";
import { ProjectService } from "../services/project-service";
import { DocumentTransitionGate } from "../services/document-transition-gate";
import {
  SourceControlService,
} from "../services/source-control-service";
import { documentContentIdentity } from "../lib/document-content-identity";
import { ensureEnginePluginStorage } from "../lib/engine-plugins";
import {
  classIdForGraphPath,
  graphsNeedCompile as compileSignatureIsStale,
} from "../services/script-compiler";
import { tryReparentUserClass } from "../lib/reparent-class";
import { ProjectSaveState } from "../lib/project-save-state";
import {
  AssetFormatVersionError,
} from "@haptic/assets";
import { useDebugMode } from "./app-settings-context";
import { formatSceneLoadReport } from "../lib/scene-load-report";
import type {
  CompileState,
  DocumentActions,
  DocumentContextValue,
  EditorShellState,
  ProjectState,
  RegistryState,
  SaveState,
  AppRoute,
} from "./document-context-types";
import {
  ActiveDocumentStateContext,
  AppRouteContext,
  CompileStateContext,
  DockWindowTickContext,
  DocumentActionsContext,
  DocumentContext,
  DocumentSubscriptionsContext,
  EditorShellStateContext,
  ProjectStateContext,
  RegistryStateContext,
  SaveStateContext,
  SourceControlStateContext,
} from "./document-context-hooks";
import { useDocumentDockLayouts } from "./use-document-dock-layouts";
import { useRefState } from "./use-ref-state";
import { installEditorTestHooks } from "./document-test-hooks";
import { useAssetThumbnails } from "./use-asset-thumbnails";
import { useExternalChanges } from "./use-external-changes";
import { useSourceControlSync } from "./use-source-control-sync";
import { useProjectList } from "./use-project-list";
import { useProjectSave } from "./use-project-save";
import { useDocumentTabs } from "./use-document-tabs";
import { useAssetFileOperations } from "./use-asset-file-operations";
import { useProjectLifecycle } from "./use-project-lifecycle";
import { useProjectAssetActions } from "./use-project-asset-actions";
import { useDocumentStateSlices } from "./use-document-state-slices";

export type {
  ActiveDocumentState,
  AppRoute,
  CloseProjectResult,
  CompileState,
  DocumentActions,
  EditorShellState,
  ProjectState,
  RegistryState,
  SaveState,
  SourceControlState,
} from "./document-context-types";
// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export {
  useActiveDocumentId,
  useActiveDocumentState,
  useAppRoute,
  useCompileState,
  useDockWindowTick,
  useDocumentActions,
  useDocumentDirty,
  useDocumentKindsRevision,
  useDocuments,
  useEditorShellState,
  useOpenDocument,
  useOpenDocumentTabs,
  useProjectState,
  useRegistryState,
  useSaveState,
  useSourceControl,
  useTabOrder,
} from "./document-context-hooks";
/* eslint-enable react-refresh/only-export-components */

export function DocumentProvider({ children }: { children: ReactNode }) {
  const projectStorage = useMemo(() => createStorage(), []);
  const projectService = useMemo(
    () => new ProjectService(projectStorage),
    [projectStorage],
  );
  useEffect(() => {
    projectService.initialize();
    return () => projectService.dispose();
  }, [projectService]);
  const settingsStore = useMemo(() => createAppSettingsStore(), []);
  const derivedStorageRef = useRef<ProjectStorage | null>(null);
  const ensureDerived = useCallback(async () => {
    if (!derivedStorageRef.current) {
      derivedStorageRef.current = await createDerivedStorage();
    }
    return derivedStorageRef.current;
  }, []);
  const documentServiceRef = useRef(new DocumentService());
  const documentTransitions = useRef(new DocumentTransitionGate()).current;
  const registerBeforeTransition = useCallback<DocumentTransitionGate["register"]>(handler => documentTransitions.register(handler), [documentTransitions]);
  const sceneDocumentLoadRef = useRef<AbortController | null>(null);
  const [sceneDocumentLoad, setSceneDocumentLoad] = useState<{ ref: DocumentRef; failed: boolean; error?: unknown } | null>(null);
  /** Why a selected tab's asset could not be read; a Scene's read failure shows in its loading dialog instead. */
  const [documentOpenError, setDocumentOpenError] = useState<string | null>(null);
  const debugMode = useDebugMode();
  useEffect(() => () => sceneDocumentLoadRef.current?.abort(), []);
  const cancelSceneDocumentLoad = useCallback(() => {
    sceneDocumentLoadRef.current?.abort();
    sceneDocumentLoadRef.current = null;
    setSceneDocumentLoad(null);
  }, []);
  const sourceControlRef = useRef(new SourceControlService());
  const editSessionRef = useRef(
    new EditSession({ maxBytes: DEFAULT_EDIT_BYTE_BUDGET }),
  );
  const [undoHistoryNotice, setUndoHistoryNotice] = useState<DocumentContextValue["undoHistoryNotice"]>(null);
  const dismissUndoHistoryNotice = useCallback(() => setUndoHistoryNotice(null), []);
  const noteUndoHistoryCleared = useCallback((id: string) => {
    setUndoHistoryNotice((current) => ({ documentId: id, sequence: (current?.sequence ?? 0) + 1 }));
  }, []);

  // Actions keep their identity across edits: the state they read when they
  // run (the project document here, templates and the pending exclusive scene
  // in their hooks) lives in refs written by their setters, never during render.
  const [route, setRoute] = useState<AppRoute>("home");
  const projectDocumentRef = useRef<ProjectDocument | null>(null);
  const [projectDocument, setProjectDocument] = useRefState(projectDocumentRef);
  const projectSaveState = useRef(new ProjectSaveState());
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [migrationPending, setMigrationPending] = useState<MigrationPending[]>(
    [],
  );
  /** Re-derives the context value after service state it reads changed (edits, tabs, saves). */
  const [contextTick, setContextTick] = useState(0);
  /** Registry-adjacent changes outside the registry itself; part of `registryEpoch`. */
  const registryTickRef = useRef(0);
  const [registryTick, setRegistryTick] = useRefState(registryTickRef);
  // Both terms only rise, so the sum changes exactly when either does.
  const registryEpoch = projectService.registryGeneration + registryTick;
  // The hooks below register their effects where they are called, and React
  // runs (and cleans up) effects in that order: keep each call where it is.
  // Effects after the scene-load abort, before the authoring-lock subscription.
  const {
    thumbnailVersions,
    thumbnailsEnabled,
    resetThumbnails,
    applyThumbnailsEnabled,
    actions: thumbnailActions,
  } = useAssetThumbnails({
    projectService,
    projectDocumentRef,
    projectDocument,
    registryEpoch,
    ensureDerived,
  });
  const [lastCompiledSignature, setLastCompiledSignature] = useState<
    string | null
  >(null);
  const documentService = documentServiceRef.current;
  const readAssetChunk = useCallback(
    (path: string, chunkId: string, options?: { ownerDocumentId?: string; scope?: AssetLoadScope; signal?: AbortSignal; priority?: AssetLoadPriority }) =>
      projectService.readAssetChunk(path, chunkId, {
        scope: options?.scope ?? documentService.getAssetLoadScope(options?.ownerDocumentId ?? documentService.getState().activeDocumentId ?? ""),
        signal: options?.signal,
        priority: options?.priority,
      }),
    [documentService, projectService],
  );
  // Play / export content loaders, script compilation and its codegen cache.
  // Every input is stable, so it is built once and its functions are actions.
  const playContent = useMemo(
    () =>
      createPlayContentService({
        documents: documentService,
        project: projectService,
        readAssetChunk,
        projectDocument: () => projectDocumentRef.current,
        onPreviewScriptsCompiled: setLastCompiledSignature,
      }),
    [documentService, projectService, readAssetChunk],
  );
  const {
    collectGraphTypeSchemas,
    collectPlayPreviewScripts,
    collectEditorUtilityScripts,
    collectPlaySpritePayloads,
    collectPlayWaterContent,
    collectPlayRenderTargets,
    collectPlayTilemapContent,
    collectPlayAreaEmissions,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayInputAssets,
    collectPlayAudio,
    collectPlayMaterialLibrary,
  } = playContent;

  const bump = useCallback(() => setContextTick((v) => v + 1), []);
  const lockAuthoring = useCallback((reason: string) => documentService.lockAuthoring(reason), [documentService]);
  const getAuthoringLock = useCallback(() => documentService.getAuthoringLock(), [documentService]);
  const subscribeAuthoringLock = useCallback((listener: () => void) => documentService.onAuthoringLockChange(listener), [documentService]);
  const lockAuthoringWrites = useCallback<ProjectService["lockAuthoringWrites"]>(reason => projectService.lockAuthoringWrites(reason), [projectService]);
  const withSceneWrite = useCallback<ProjectService["withSceneWrite"]>(work => projectService.withSceneWrite(work), [projectService]);
  useEffect(() => documentService.onAuthoringLockChange(bump), [bump, documentService]);
  /** Plugins, search index or Show Plugin Content changed: advance `registryEpoch`. */
  const bumpRegistry = useCallback(() => setRegistryTick((v) => v + 1), [setRegistryTick]);
  const {
    animEditorModes,
    setAnimEditorModes,
    focusedLayoutIds,
    dockWindowTick,
    captureLayoutForId,
    captureAllLayouts,
    resetDockLayouts,
    moveDockLayouts,
    forgetDockLayouts,
    registerDockviewApi,
    unregisterDockviewApi,
    setAnimEditorMode,
    setSceneMode,
    activateDockPanel,
    toggleDockWindow,
    isDockWindowOpen,
    getOpenDockWindowCount,
    toggleLayoutFocus,
  } = useDocumentDockLayouts({ documentService, projectService, sourceControlRef, settingsStore, bump });
  useEffect(() => attachEditGestureBoundaries(() => {
    const id = documentService.getState().activeDocumentId;
    if (id) editSessionRef.current.getStack(id).endGesture();
  }), [documentService]);
  // History kept from a closed tab resumes only on the content it was built
  // on; a reopen that loads anything else (external or source control
  // changes, repaired references) starts empty.
  useEffect(() => documentService.onIdentityChange((event) => {
    if (event.type !== "opened") return;
    const content = documentService.getDocument(event.id)?.content;
    if (!content) {
      editSessionRef.current.dropDocument(event.id);
      return;
    }
    editSessionRef.current.reopenDocument(event.id, () =>
      documentContentIdentity(content),
    );
  }), [documentService]);
  /** Set once `closeDocumentsForPaths` exists; reload closes tabs whose file is gone. */
  const closeDocumentsForPathsRef = useRef<(paths: Iterable<string>) => void>(() => {});
  // Effects after the history-reopen subscription, before source control's.
  const {
    externalChangePrompt,
    captureMtimeSnapshot,
    runForegroundRescanRef,
    resetExternalChanges,
    actions: externalChangeActions,
  } = useExternalChanges({
    projectService,
    documentService,
    editSessionRef,
    projectDocumentRef,
    projectSaveState,
    setProjectDocument,
    bump,
    closeDocumentsForPathsRef,
  });
  // Effects after the own-write snapshot update, before the journal flush on hide.
  const { sourceControlState, actions: sourceControlActions } = useSourceControlSync({
    sourceControlRef,
    projectService,
    settingsStore,
    projectDocument,
    runForegroundRescanRef,
  });

  // Applied edits reach the recovery journal in short batches; every path
  // that reads, clears or abandons the journal flushes first. One buffer for
  // the provider's lifetime keeps each project's writes in order.
  const [journalBuffer] = useState(
    () =>
      new JournalBuffer(async (guid, lines) =>
        appendJournalLines(await ensureDerived(), guid, lines),
      ),
  );
  useEffect(() => attachJournalFlushOnHide(journalBuffer), [journalBuffer]);

  // Effects after the journal flush on hide, before the mount effect below.
  const {
    listedProjects,
    needsReconnect,
    setNeedsReconnect,
    homepageReady,
    setHomepageReady,
    templates,
    templatesRef,
    recordRecent,
    refreshProjectList,
    refreshTemplates,
    actions: projectListActions,
  } = useProjectList({ projectService, settingsStore, route });

  useEffect(() => {
    documentService.ensureContentBrowserTab();
    let mounted = true;
    void Promise.allSettled([refreshProjectList(), refreshTemplates()]).then(() => {
      if (mounted) setHomepageReady(true);
    });
    void settingsStore.load().then((settings) => {
      editSessionRef.current.configure({
        maxEntries: settings.undoHistoryLength,
        maxBytes: settings.undoByteBudget,
      });
      applyThumbnailsEnabled(settings.thumbnailsEnabled !== false);
    });
    bump();
    return () => {
      mounted = false;
    };
  }, [applyThumbnailsEnabled, bump, documentService, refreshProjectList, refreshTemplates, setHomepageReady, settingsStore]);

  // Undo preferences apply to every open document's history as they change.
  useEffect(() => {
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<Partial<EngineSettings>>).detail;
      editSessionRef.current.configure({
        maxEntries: detail?.undoHistoryLength,
        maxBytes: detail?.undoByteBudget,
      });
      bump();
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () => window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  }, [bump]);

  useEffect(
    () => projectService.onRegistryChange(bumpRegistry),
    [bumpRegistry, projectService],
  );


  const noteAssetsCreated = useCallback(() => {
    const paths = projectService.registry?.listDocumentPaths({ rootId: "project" });
    if (paths) {
      setProjectDocument((current) =>
        current
          ? { ...current, scenes: paths.scenes, graphs: paths.graphs }
          : current,
      );
    }
    bump();
  }, [bump, projectService, setProjectDocument]);

  const refreshAssetRegistry = useCallback(async () => {
    await projectService.remountRegistry();
    noteAssetsCreated();
  }, [noteAssetsCreated, projectService]);

  const subscribeDocumentIdentity = useCallback(
    (listener: DocumentIdentityListener) =>
      documentService.onIdentityChange(listener),
    [documentService],
  );

  const getOpenDocuments = useCallback(
    () => documentService.getOpenDocumentsOrdered(),
    [documentService],
  );

  useEffect(() => {
    void ensureEnginePluginStorage();
  }, []);

  // Effects after the engine plugin storage effect, before the recovery replay.
  const {
    autoSaveStatus,
    setAutoSaveStatus,
    migrationPromptRequest,
    cancelDebouncedSave,
    enqueueProjectWrite,
    scheduleDebouncedSave,
    saveAll,
    saveProjectNow,
    actions: saveActions,
  } = useProjectSave({
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
  });

  // The edit pipeline (apply*, Undo / Redo, Simulation apply, journal append
  // and recovery replay, prefab sync). Every input is stable, so it is built
  // once and the actions below delegate to it.
  const editing = useMemo(
    () =>
      new DocumentEditingService({
        documents: documentService,
        editSession: editSessionRef.current,
        project: projectService,
        sourceControl: sourceControlRef.current,
        journal: journalBuffer,
        derivedStorage: ensureDerived,
        bump,
        scheduleDebouncedSave,
        onHistoryCleared: noteUndoHistoryCleared,
        registryTick: () => registryTickRef.current,
        isProjectDirty: () => projectSaveState.current.isDirty(projectDocumentRef.current),
        onRecoveryResolved: () => setRecoveryAvailable(false),
      }),
    [bump, documentService, ensureDerived, journalBuffer, noteUndoHistoryCleared, projectService, scheduleDebouncedSave],
  );

  // Its layout effect follows the external-change hook's.
  const {
    pendingExclusiveScene,
    finishOpenDocument,
    cancelExclusiveSceneOpen,
    actions: tabActions,
  } = useDocumentTabs({
    documentService,
    projectService,
    documentTransitions,
    editSessionRef,
    journalBuffer,
    sourceControlRef,
    ensureDerived,
    editing,
    saveAll,
    bump,
    captureLayoutForId,
    forgetDockLayouts,
    sceneDocumentLoadRef,
    setSceneDocumentLoad,
    cancelSceneDocumentLoad,
    setDocumentOpenError,
    closeDocumentsForPathsRef,
  });
  const { actions: fileOperationActions } = useAssetFileOperations({
    documentService,
    projectService,
    editSessionRef,
    journalBuffer,
    sourceControlRef,
    projectDocumentRef,
    projectSaveState,
    setProjectDocument,
    bump,
    captureLayoutForId,
    moveDockLayouts,
    captureAllLayouts,
    collectGraphTypeSchemas,
    captureMtimeSnapshot,
    enqueueProjectWrite,
    cancelDebouncedSave,
    scheduleDebouncedSave,
    saveProjectNow,
  });
  // Effects after the deferred auto-save, before the open Texture Usage effect.
  const { actions: lifecycleActions } = useProjectLifecycle({
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
  });
  // Effects after the recovery replay, before the test hooks.
  const { actions: projectAssetActions } = useProjectAssetActions({
    projectService,
    documentService,
    sourceControlRef,
    projectDocumentRef,
    ensureDerived,
    bump,
    bumpRegistry,
    scheduleDebouncedSave,
  });

  const updateProjectVersion = useCallback((version: string) => {
    if (documentService.getAuthoringLock().readOnly) return;
    setProjectDocument(current => current ? {
      ...current,
      metadata: { ...current.metadata, version, updatedAt: new Date().toISOString() },
    } : current);
    scheduleDebouncedSave();
  }, [documentService, scheduleDebouncedSave, setProjectDocument]);

  const updateProjectSettings = useCallback(
    (settings: Partial<ProjectDocument["settings"]>) => {
      if (documentService.getAuthoringLock().readOnly) return;
      setProjectDocument((current) => {
        if (!current) return current;
        return {
          ...current,
          settings: normalizeProjectSettings({
            ...current.settings,
            ...settings,
            textures: {
              ...current.settings.textures,
              ...settings.textures,
            },
            twoD: {
              ...current.settings.twoD,
              ...settings.twoD,
            },
            physics: {
              ...current.settings.physics,
              ...settings.physics,
            },
            playPreview: {
              ...current.settings.playPreview,
              ...settings.playPreview,
            },
            render: {
              ...current.settings.render,
              ...settings.render,
            },
            fonts: {
              ...current.settings.fonts,
              ...settings.fonts,
            },
            audio: {
              ...current.settings.audio,
              ...settings.audio,
            },
            sourceControl: {
              ...current.settings.sourceControl,
              ...settings.sourceControl,
            },
          }),
          metadata: {
            ...current.metadata,
            updatedAt: new Date().toISOString(),
          },
        };
      });
      scheduleDebouncedSave();
    },
    [documentService, scheduleDebouncedSave, setProjectDocument],
  );

  const repathProjectFolder = useCallback(
    (fromFolder: string, toFolder: string) => {
      const current = projectDocumentRef.current;
      if (!current) return;
      const folders = remapAlwaysPackageFolders(current.settings.alwaysPackageFolders, fromFolder, toFolder);
      if (folders.length === current.settings.alwaysPackageFolders.length && folders.every((folder, index) => folder === current.settings.alwaysPackageFolders[index])) return;
      setProjectDocument({
        ...current,
        settings: { ...current.settings, alwaysPackageFolders: folders },
        metadata: { ...current.metadata, updatedAt: new Date().toISOString() },
      });
      scheduleDebouncedSave();
    },
    [scheduleDebouncedSave, setProjectDocument],
  );

  const applyGraphChange = useCallback<DocumentContextValue["applyGraphChange"]>(
    (id, next) => editing.applyGraphChange(id, next),
    [editing],
  );

  const reparentClassDocument = useCallback(
    async (id: string, newParentId: string): Promise<string | null> => {
      const doc = documentService.getState().openDocuments.get(id);
      if (!doc || doc.ref.kind !== "graph" || !doc.content) {
        return "Class document is not open.";
      }
      if (editing.isApplyBlocked(doc.ref.path)) {
        return documentService.getAuthoringLock().reason ?? "This Class is locked.";
      }
      const classId = classIdForGraphPath(doc.ref.path);
      const assets = projectService.registry?.list() ?? [];
      const preview = tryReparentUserClass({
        classId,
        newParentId,
        assets,
      });
      if (preview.ok === false) return preview.error;
      try {
        // The parent is a file operation like a rename: it goes to disk now with
        // the saved graph, while the tab's unsaved edits stay unsaved.
        const saved = await projectService.loadDocument("graph", doc.ref.path);
        await projectService.saveDocument("graph", doc.ref.path, saved, { parentClass: newParentId });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      // The graph signature does not cover the header's parent, so Compile
      // would otherwise keep the previous parent.
      setLastCompiledSignature(null);
      bump();
      return null;
    },
    [bump, documentService, editing, projectService],
  );

  const beginSimulationDocument = useCallback<DocumentContextValue["beginSimulationDocument"]>(
    (id) => editing.beginSimulationDocument(id),
    [editing],
  );

  const applySceneChange = useCallback<DocumentContextValue["applySceneChange"]>(
    (id, next, options) => editing.applySceneChange(id, next, options),
    [editing],
  );

  const applyAssetDocumentChange = useCallback<DocumentContextValue["applyAssetDocumentChange"]>(
    (id, next, mergeKey) => editing.applyAssetDocumentChange(id, next, mergeKey),
    [editing],
  );

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    return installEditorTestHooks({
      projectService,
      documentService,
      sourceControl: sourceControlRef.current,
      journalBuffer,
      ensureDerived,
      bump,
      cancelDebouncedSave,
      projectDocument: () => projectDocumentRef.current,
      isProjectDirty: () => projectSaveState.current.isDirty(projectDocumentRef.current),
      runForegroundRescan: () => runForegroundRescanRef.current(),
      applyGraphChange,
      applySceneChange,
      updateProjectSettings,
    });
  }, [
    cancelDebouncedSave,
    applyGraphChange,
    reparentClassDocument,
    applySceneChange,
    applyAssetDocumentChange,
    bump,
    documentService,
    ensureDerived,
    journalBuffer,
    projectService,
    updateProjectSettings,
    runForegroundRescanRef,
  ]);

  const undoActiveDocument = useCallback(() => {
    editing.stepHistory("undo");
  }, [editing]);

  const redoActiveDocument = useCallback(() => {
    editing.stepHistory("redo");
  }, [editing]);


  // Every callback above and in each hook's action group keeps its identity
  // for the provider's lifetime (the state it reads lives in refs or
  // services), so this object is created once and action-only consumers never
  // re-render when documents change.
  const actions = useMemo<DocumentActions>(
    () => ({
      ...thumbnailActions,
      ...externalChangeActions,
      ...sourceControlActions,
      ...projectListActions,
      ...saveActions,
      ...tabActions,
      ...fileOperationActions,
      ...lifecycleActions,
      ...projectAssetActions,
      lockAuthoring,
      beginSimulationDocument,
      getAuthoringLock,
      subscribeAuthoringLock,
      lockAuthoringWrites,
      registerBeforeTransition,
      withSceneWrite,
      refreshAssetRegistry,
      noteAssetsCreated,
      repathProjectFolder,
      subscribeDocumentIdentity,
      collectPlayAreaEmissions,
      getOpenDocuments,
      applyGraphChange,
      reparentClassDocument,
      applySceneChange,
      applyAssetDocumentChange,
      readAssetChunk,
      updateProjectVersion,
      updateProjectSettings,
      undoActiveDocument,
      dismissUndoHistoryNotice,
      redoActiveDocument,
      registerDockviewApi,
      unregisterDockviewApi,
      captureLayoutForId,
      setAnimEditorMode,
      setSceneMode,
      activateDockPanel,
      toggleDockWindow,
      isDockWindowOpen,
      getOpenDockWindowCount,
      toggleLayoutFocus,
      collectPlayPreviewScripts,
      collectEditorUtilityScripts,
      collectPlaySpritePayloads,
      collectPlayWaterContent,
      collectPlayRenderTargets,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayTexturePixelSizes,
      collectPlayFontFacetypeBytes,
      collectPlayFontMsdfPair,
      collectPlayFontFaceEntries,
      collectPlayFontCssStacks,
      collectPlayModelBytes,
      collectPlayModelPayloads,
      collectPlayInputAssets,
      collectPlayAudio,
      collectPlayMaterialLibrary,
    }),
    [
      thumbnailActions,
      externalChangeActions,
      sourceControlActions,
      projectListActions,
      saveActions,
      tabActions,
      fileOperationActions,
      lifecycleActions,
      projectAssetActions,
      lockAuthoring,
      beginSimulationDocument,
      getAuthoringLock,
      subscribeAuthoringLock,
      lockAuthoringWrites,
      registerBeforeTransition,
      withSceneWrite,
      refreshAssetRegistry,
      noteAssetsCreated,
      repathProjectFolder,
      subscribeDocumentIdentity,
      collectPlayAreaEmissions,
      getOpenDocuments,
      applyGraphChange,
      reparentClassDocument,
      applySceneChange,
      applyAssetDocumentChange,
      readAssetChunk,
      updateProjectVersion,
      updateProjectSettings,
      undoActiveDocument,
      dismissUndoHistoryNotice,
      redoActiveDocument,
      registerDockviewApi,
      unregisterDockviewApi,
      captureLayoutForId,
      setAnimEditorMode,
      setSceneMode,
      activateDockPanel,
      toggleDockWindow,
      isDockWindowOpen,
      getOpenDockWindowCount,
      toggleLayoutFocus,
      collectPlayPreviewScripts,
      collectEditorUtilityScripts,
      collectPlaySpritePayloads,
      collectPlayWaterContent,
      collectPlayRenderTargets,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayTexturePixelSizes,
      collectPlayFontFacetypeBytes,
      collectPlayFontMsdfPair,
      collectPlayFontFaceEntries,
      collectPlayFontCssStacks,
      collectPlayModelBytes,
      collectPlayModelPayloads,
      collectPlayInputAssets,
      collectPlayAudio,
      collectPlayMaterialLibrary,
    ],
  );

  // Last: its layout effect publishes to the narrow subscriptions after every
  // other layout effect in the commit.
  const {
    documentRevisions,
    tabsRevision,
    tabOrder,
    openDocuments,
    dirtyDocuments,
    stableDirtyDocuments,
    subscriptions,
    activeDocumentState,
  } = useDocumentStateSlices({
    documentService,
    editSessionRef,
    animEditorModes,
    focusedLayoutIds,
  });
  const graphSignatureRevision = documentKindsRevision(
    documentRevisions,
    GRAPH_SIGNATURE_KINDS,
  );
  const currentGraphSignature = useMemo(() => {
    void graphSignatureRevision;
    void registryEpoch;
    return playContent.graphSignature(projectDocument?.settings.tags);
  }, [graphSignatureRevision, playContent, projectDocument?.settings.tags, registryEpoch]);

  const projectState = useMemo<ProjectState>(
    () => ({ projectDocument, projectName: projectDocument?.metadata.name ?? null }),
    [projectDocument],
  );
  const assetRegistry = projectService.registry;
  const extensionService = projectService.extensions;
  const projectGuid = projectService.guid;
  const pluginDescriptors = projectService.plugins;
  const pluginDiagnostics = projectService.pluginGraphDiagnostics;
  const showPluginContent = documentService.getState().showPluginContent === true;
  const searchIndex = projectService.searchIndex;
  const encodingTextures = projectService.textureEncodingGuids;
  const registryState = useMemo<RegistryState>(
    () => ({
      assetRegistry,
      registryEpoch,
      encodingTextures,
      projectGuid,
      extensionService,
      pluginDescriptors,
      pluginDiagnostics,
      showPluginContent,
      searchIndex,
    }),
    [assetRegistry, registryEpoch, encodingTextures, projectGuid, extensionService, pluginDescriptors, pluginDiagnostics, showPluginContent, searchIndex],
  );
  const projectDirty = projectSaveState.current.isDirty(projectDocument);
  const saveState = useMemo<SaveState>(
    () => ({ dirtyDocuments: stableDirtyDocuments, projectDirty, autoSaveStatus, recoveryAvailable }),
    [stableDirtyDocuments, projectDirty, autoSaveStatus, recoveryAvailable],
  );
  const compileState = useMemo<CompileState>(
    () => ({
      graphsNeedCompile: compileSignatureIsStale(
        currentGraphSignature,
        lastCompiledSignature,
      ),
      currentGraphSignature,
    }),
    [currentGraphSignature, lastCompiledSignature],
  );
  const editorShellState = useMemo<EditorShellState>(
    () => ({
      listedProjects,
      needsReconnect,
      recoveryAvailable,
      migrationPending,
      migrationPromptRequest,
      templates,
      homepageReady,
      pendingExclusiveScene,
      externalChangePrompt,
      undoHistoryNotice,
      thumbnailVersions,
      thumbnailsEnabled,
    }),
    [listedProjects, needsReconnect, recoveryAvailable, migrationPending, migrationPromptRequest, templates, homepageReady, pendingExclusiveScene, externalChangePrompt, undoHistoryNotice, thumbnailVersions, thumbnailsEnabled],
  );

  /** The `useDocuments()` facade: the stable actions plus per-edit state. */
  const value = useMemo<DocumentContextValue>(
    () => {
      // Service state read below (undo stacks, layouts) changed.
      void contextTick;
      return {
        ...actions,
        ...projectState,
        ...registryState,
        ...activeDocumentState,
        ...compileState,
        ...editorShellState,
        ...sourceControlState,
        route,
        openDocuments,
        documentRevisions,
        tabsRevision,
        tabOrder,
        // Unlike the save slice's list, recomputed on every revision.
        dirtyDocuments,
        projectDirty,
        autoSaveStatus,
      };
    },
    [
      actions,
      contextTick,
      projectState,
      registryState,
      activeDocumentState,
      compileState,
      editorShellState,
      sourceControlState,
      route,
      openDocuments,
      documentRevisions,
      tabsRevision,
      tabOrder,
      dirtyDocuments,
      projectDirty,
      autoSaveStatus,
    ],
  );

  return (
    <DocumentActionsContext.Provider value={actions}>
      <AppRouteContext.Provider value={route}>
        <DocumentSubscriptionsContext.Provider value={subscriptions}>
          <ProjectStateContext.Provider value={projectState}>
            <RegistryStateContext.Provider value={registryState}>
              <ActiveDocumentStateContext.Provider value={activeDocumentState}>
                <SaveStateContext.Provider value={saveState}>
                  <CompileStateContext.Provider value={compileState}>
                    <EditorShellStateContext.Provider value={editorShellState}>
                      <SourceControlStateContext.Provider value={sourceControlState}>
                        <DocumentContext.Provider value={value}>
                          <DockWindowTickContext.Provider value={dockWindowTick}>
                            {children}
                          </DockWindowTickContext.Provider>
                          <SceneLoadingDialog
                            open={sceneDocumentLoad !== null}
                            progress={null}
                            phase="Loading Document"
                            failed={sceneDocumentLoad?.failed}
                            onRetry={() => { if (sceneDocumentLoad) void finishOpenDocument(sceneDocumentLoad.ref); }}
                            onDismiss={cancelSceneDocumentLoad}
                            reason={sceneDocumentLoad?.error instanceof AssetFormatVersionError ? sceneDocumentLoad.error.message : undefined}
                            onCopyDetails={debugMode && sceneDocumentLoad ? () => formatSceneLoadReport({
                              surface: "Scene Document", scene: sceneDocumentLoad.ref.path, phase: "Loading Document",
                              progress: null, failed: sceneDocumentLoad.failed, elapsedMs: null, error: sceneDocumentLoad.error,
                            }) : undefined}
                          />
                          <DocumentOpenErrorDialog
                            error={documentOpenError}
                            onClose={() => setDocumentOpenError(null)}
                            testId="document-open-error"
                            dismissTestId="document-open-error-dismiss"
                          />
                        </DocumentContext.Provider>
                      </SourceControlStateContext.Provider>
                    </EditorShellStateContext.Provider>
                  </CompileStateContext.Provider>
                </SaveStateContext.Provider>
              </ActiveDocumentStateContext.Provider>
            </RegistryStateContext.Provider>
          </ProjectStateContext.Provider>
        </DocumentSubscriptionsContext.Provider>
      </AppRouteContext.Provider>
    </DocumentActionsContext.Provider>
  );
}
