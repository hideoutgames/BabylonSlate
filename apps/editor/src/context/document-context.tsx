import { parseSceneDocumentLayout } from "../shell/scene-document-layout";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DocumentSubscriptions, sameDocumentRef } from "./document-subscriptions";
import { flushSync } from "react-dom";
import { SceneLoadingDialog } from "../components/scene-loading-dialog";
import { waitForSceneLoadingPaint } from "../lib/scene-viewport-load";
import type {
  AssetDocumentKind,
  DocumentRef,
  ProjectDocument,
  PluginEnableOverride,
  ProjectFolderHandle,
  ProjectMetadata,
  SerializedGraph,
  SerializedScene,
  SerializedSceneLayer,
} from "@haptic/core";
import { ASSET_DOCUMENT_KINDS, createDocumentRef, documentId, isAssetDocumentKind, isSceneWorkspaceKind, normalizeProjectSettings, remapAlwaysPackageFolders, removeAlwaysPackageFolders, DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@haptic/core";
import {
  appendJournalLines,
  discardSealedJournal,
  readSealedJournalLines,
  readThumbnail,
  sealJournalForRecovery,
  writeThumbnail,
  ThumbnailDecodeLru,
  truncateJournal,
  clearDeletedAssetRefs,
  clearDeletedRefsFromProjectSettings,
  replaceClassAssetReferences,
  renamedAssetPath,
  type ClassAssetReplacement,
  type AssetLoadScope,
  type AssetLoadPriority,
  type AssetLoadState,
  type MigrationPending,
  type ProjectTemplateCatalogEntry,
  newAssetGuid,
  listTraceDocuments,
  pruneTraceDocuments,
} from "@haptic/assets";
import {
  DEFAULT_EDIT_BYTE_BUDGET,
  EditSession,
  journalRepathLine,
  journalDiscardLine,
  journalCheckpointLine,
  resolveJournalLines,
} from "@haptic/edit";
import { attachJournalFlushOnHide, JournalBuffer } from "../lib/journal-buffer";
import {
  createAppSettingsStore,
  createDerivedStorage,
  createStorage,
  getHostPlatform,
  isTestModeEnabled,
  createSecretStore,
  createNativeHttp,
  ENGINE_SETTINGS_CHANGED_EVENT,
  type EngineSettings,
} from "@haptic/vfs";
import type { ProjectStorage } from "@haptic/core";
import type { ScriptBundleEntry } from "@haptic/bridge";
import type { Diagnostic } from "@haptic/scripting";
import type { TracePayload } from "@haptic/debugger";
import {
  DocumentService,
  documentKindsRevision,
  type DocumentIdentityListener,
  type OpenDocument,
} from "../services/document-service";
import { DocumentEditingService } from "../services/document-editing-service";
import { createPlayContentService, GRAPH_SIGNATURE_KINDS } from "../services/play-content-service";
import { attachEditGestureBoundaries } from "../services/edit-gesture-boundaries";
import { ProjectService } from "../services/project-service";
import { DocumentTransitionGate } from "../services/document-transition-gate";
import {
  readGitPrefill,
  SourceControlService,
} from "../services/source-control-service";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { requeueWithEditLock } from "../lib/document-lock-apply";
import { dirtyScenesBlockingOpen } from "../lib/exclusive-scene";
import { documentContentIdentity } from "../lib/document-content-identity";
import {
  recordedTraceFileName,
  spillRecordedTraceDocument,
} from "../lib/play-trace-spill";
import { ensureEnginePluginStorage } from "../lib/engine-plugins";
import { ensureEngineExtensionStorage } from "../lib/engine-extensions";
import { ensureEngineExtensionLibrary } from "../lib/engine-extension-library";
import { ensureEnginePluginLibrary } from "../lib/engine-plugin-library";
import { loadTemplateCards, loadSelectedTemplateFiles } from "../services/template-service";
import {
  classIdForGraphPath,
  graphsNeedCompile as compileSignatureIsStale,
} from "../services/script-compiler";
import { playBundlesNeedCollect } from "../services/play-preview-prepare";
import type { CreateProjectOptions } from "../lib/create-project";
import type { ExportArtifact } from "@haptic/exporter";
import {
  zipGameArtifact,
} from "../services/export-game";
import { flushAudioReverbForSave } from "../lib/audio-reverb-bake";
import {
  flushNavBakeForSave,
} from "../lib/nav-bake-save";
import {
  dockviewApiKey,
} from "../shell/dockview-surface";
import { editorKtx2PublicBase } from "../lib/public-engine-assets";
import {
  classIdFromClassAsset,
} from "../lib/class-asset-lookup";
import {
  editorTabContentForKind,
  persistableDocumentContent,
} from "../lib/scene-layer-document";
import { tryReparentUserClass } from "../lib/reparent-class";
import {
  createProjectPluginAndRevealContent,
  isPluginDocumentReadOnly,
} from "../lib/plugin-ui";
import { readProjectJsonMtime, refreshMtimeSnapshotAfterEditorSave } from "../lib/external-change";
import { ProjectSaveState } from "../lib/project-save-state";
import {
  AssetFormatVersionError,
  applyOwnAssetWrite,
  derivedDataRoot,
  classifyExternalChanges,
  snapshotIndexedMtimes,
  type ExternalChangeClassification,
} from "@haptic/assets";
import {
  listedProjectsFromRecents,
  recentProjectsWithOpenedProject,
  shouldDeleteOpfsOnRemove,
  type ListedProject,
  type UpdateListedProjectOptions,
} from "../lib/listed-projects";
import {
  EDITOR_UTILITY_EVENTS,
  emitEditorUtilityLifecycle,
} from "../lib/editor-utility-scripts";
import {
  beginSaveAllProgress,
  recordSaveAllTrace,
} from "../lib/dirty-trace";
import { enqueueModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import {
  createAssetThumbnailRevisionIndex,
  type AssetThumbnailWriteIdentity,
} from "../lib/asset-thumbnail-revision";
import { useDebugMode } from "./app-settings-context";
import { formatSceneLoadReport } from "../lib/scene-load-report";
import type {
  ActiveDocumentState,
  CloseProjectResult,
  CompileState,
  DocumentActions,
  DocumentContextValue,
  EditorShellState,
  ProjectState,
  RegistryState,
  SaveState,
  SourceControlState,
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
import { animEditorModeForDocument, useDocumentDockLayouts } from "./use-document-dock-layouts";
import { useRefState } from "./use-ref-state";
import { installEditorTestHooks } from "./document-test-hooks";
import { exportProjectGameArtifact, type ExportGameArtifactOptions } from "../services/export-game-artifact";

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

const THUMBNAIL_DECODE_LRU_ENTRIES = 64;

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
  const documentServiceRef = useRef(new DocumentService());
  const documentTransitions = useRef(new DocumentTransitionGate()).current;
  const registerBeforeTransition = useCallback<DocumentTransitionGate["register"]>(handler => documentTransitions.register(handler), [documentTransitions]);
  const sceneDocumentLoadRef = useRef<AbortController | null>(null);
  const [sceneDocumentLoad, setSceneDocumentLoad] = useState<{ ref: DocumentRef; failed: boolean; error?: unknown } | null>(null);
  const debugMode = useDebugMode();
  useEffect(() => () => sceneDocumentLoadRef.current?.abort(), []);
  const cancelSceneDocumentLoad = useCallback(() => {
    sceneDocumentLoadRef.current?.abort();
    sceneDocumentLoadRef.current = null;
    setSceneDocumentLoad(null);
  }, []);
  const sourceControlRef = useRef(new SourceControlService());
  const secretStore = useMemo(() => createSecretStore(), []);
  const nativeHttp = useMemo(() => createNativeHttp(), []);
  const [sourceControlTick, setSourceControlTick] = useState(0);
  const [externalChangePrompt, setExternalChangePrompt] =
    useState<ExternalChangeClassification | null>(null);
  const mtimeSnapshotRef = useRef<{
    assets: Record<string, number | null>;
    projectJson: number | null;
  } | null>(null);
  const editSessionRef = useRef(
    new EditSession({ maxBytes: DEFAULT_EDIT_BYTE_BUDGET }),
  );
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
  const [undoHistoryNotice, setUndoHistoryNotice] = useState<DocumentContextValue["undoHistoryNotice"]>(null);
  const dismissUndoHistoryNotice = useCallback(() => setUndoHistoryNotice(null), []);
  const noteUndoHistoryCleared = useCallback((id: string) => {
    setUndoHistoryNotice((current) => ({ documentId: id, sequence: (current?.sequence ?? 0) + 1 }));
  }, []);
  // Keyed by saved revision, and projects made from one template share guids:
  // enterEditor replaces it so one project never shows another's thumbnails.
  const thumbnailLruRef = useRef(new ThumbnailDecodeLru(THUMBNAIL_DECODE_LRU_ENTRIES));
  const requestedThumbnailRevisionsRef = useRef(new Map<string, string>());
  const thumbnailsEnabledRef = useRef(true);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<string, number>>({});

  // Actions keep their identity across edits: the state they read when they
  // run (the project document, templates, the pending exclusive scene) lives
  // in refs written by these setters, never during render.
  const [route, setRoute] = useState<AppRoute>("home");
  const projectDocumentRef = useRef<ProjectDocument | null>(null);
  const [projectDocument, setProjectDocument] = useRefState(projectDocumentRef);
  const projectSaveState = useRef(new ProjectSaveState());
  const [listedProjects, setListedProjects] = useState<ListedProject[]>([]);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  const [migrationPending, setMigrationPending] = useState<MigrationPending[]>(
    [],
  );
  const [migrationPromptRequest, setMigrationPromptRequest] = useState(0);
  const [homepageReady, setHomepageReady] = useState(false);
  const templatesRef = useRef<ProjectTemplateCatalogEntry[]>([]);
  const [templates, setTemplates] = useRefState(templatesRef);
  /** Re-derives the context value after service state it reads changed (edits, tabs, saves). */
  const [contextTick, setContextTick] = useState(0);
  /** Registry-adjacent changes outside the registry itself; part of `registryEpoch`. */
  const registryTickRef = useRef(0);
  const [registryTick, setRegistryTick] = useRefState(registryTickRef);
  // Both terms only rise, so the sum changes exactly when either does.
  const registryEpoch = projectService.registryGeneration + registryTick;
  const previousThumbnailIndexRef = useRef<ReturnType<typeof createAssetThumbnailRevisionIndex> | null>(null);
  const thumbnailRevisionIndex = useMemo(
    () => {
      void registryEpoch;
      const assets = projectService.registry?.list() ?? [];
      const previous = previousThumbnailIndexRef.current;
      // Plugin and search-index changes also advance the epoch. Reuse saved
      // revisions until an indexed header actually changes.
      const pixelsPerUnit = projectDocument?.settings.twoD.pixelsPerUnit;
      const next = previous?.matches(assets, pixelsPerUnit) ? previous : createAssetThumbnailRevisionIndex(assets, pixelsPerUnit);
      previousThumbnailIndexRef.current = next;
      return next;
    },
    [projectDocument?.settings.twoD.pixelsPerUnit, projectService, registryEpoch],
  );
  const thumbnailRevisionIndexRef = useRef(thumbnailRevisionIndex);
  useLayoutEffect(() => {
    thumbnailRevisionIndexRef.current = thumbnailRevisionIndex;
  }, [thumbnailRevisionIndex]);
  useEffect(() => {
    const changed: string[] = [];
    for (const [guid, previous] of requestedThumbnailRevisionsRef.current) {
      const next = thumbnailRevisionIndex.revision(guid);
      if (next === previous) continue;
      if (next === null) requestedThumbnailRevisionsRef.current.delete(guid);
      else requestedThumbnailRevisionsRef.current.set(guid, next);
      changed.push(guid);
    }
    if (changed.length) setThumbnailVersions((versions) => {
      const next = { ...versions };
      for (const guid of changed) next[guid] = (next[guid] ?? 0) + 1;
      return next;
    });
  }, [thumbnailRevisionIndex]);
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState(true);
  const pendingExclusiveSceneRef = useRef<DocumentRef | null>(null);
  const [pendingExclusiveScene, setPendingExclusiveScene] = useRefState(
    pendingExclusiveSceneRef,
  );
  const exclusiveSceneRequest = useRef(0);
  /** The latest tab activation the user asked for; an earlier, slower open does not take focus from it. */
  const activationRequest = useRef(0);
  const [lastCompiledSignature, setLastCompiledSignature] = useState<
    string | null
  >(null);
  const [playLoadedSignature, setPlayLoadedSignature] = useState<string | null>(
    null,
  );
  const [playPreviewBundles, setPlayPreviewBundles] = useState<
    ScriptBundleEntry[]
  >([]);
  const [playPreviewDiagnostics, setPlayPreviewDiagnostics] = useState<
    Diagnostic[]
  >([]);
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
        onPreviewScriptsCompiled: (signature, bundles, nextDiagnostics) => {
          setLastCompiledSignature(signature);
          setPlayLoadedSignature(signature);
          setPlayPreviewBundles(bundles);
          setPlayPreviewDiagnostics(nextDiagnostics);
        },
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
  const clearPlayPreviewScripts = useCallback(() => {
    setPlayLoadedSignature(null);
    setPlayPreviewBundles([]);
    setPlayPreviewDiagnostics([]);
  }, []);

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
  const runForegroundRescanRef = useRef<() => Promise<void>>(async () => {});

  const captureMtimeSnapshot = useCallback(async () => {
    // Installed before the project.json read, so the editor's own writes that
    // land meanwhile fold into this snapshot, not the one it replaces.
    const snapshot = {
      assets: snapshotIndexedMtimes(projectService.registry?.list() ?? []),
      projectJson: mtimeSnapshotRef.current?.projectJson ?? null,
    };
    mtimeSnapshotRef.current = snapshot;
    snapshot.projectJson = await readProjectJsonMtime(projectService.storagePort);
  }, [projectService]);

  // The editor's own Texture encode writes are not external changes.
  useEffect(
    () =>
      projectService.onOwnAssetWrite((write) => {
        const snapshot = mtimeSnapshotRef.current;
        if (snapshot) applyOwnAssetWrite(snapshot.assets, write);
      }),
    [projectService],
  );

  useEffect(() => {
    return sourceControlRef.current.subscribe(() => {
      setSourceControlTick((tick) => tick + 1);
    });
  }, []);

  useEffect(() => {
    if (!projectDocument) {
      sourceControlRef.current.dispose();
      return;
    }
    void sourceControlRef.current.configure({
      settings:
        projectDocument.settings.sourceControl ??
        DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
      projectGuid: projectService.guid,
      platform: getHostPlatform(),
      testMode: isTestModeEnabled(),
      secretStore,
      nativeHttp,
    });
  }, [
    nativeHttp,
    projectDocument,
    projectService.guid,
    secretStore,
  ]);

  const sourceControlEnabled = projectDocument
    ? projectDocument.settings.sourceControl?.enabled === true
    : null;
  // Not via the debounced project save: turning source control on must stop
  // the texture alignment pass's queued re-encodes at once.
  useEffect(() => {
    if (sourceControlEnabled !== null) projectService.setSourceControlEnabled(sourceControlEnabled);
  }, [projectService, sourceControlEnabled]);
  useEffect(() => {
    if (sourceControlEnabled === null) return;
    const folder = projectService.storagePort.getCurrentFolder();
    if (!folder) return;
    void settingsStore.update((settings) => {
      settings.recents = settings.recents.map((recent) =>
        recent.id === folder.id && recent.sourceControl !== sourceControlEnabled
          ? { ...recent, sourceControl: sourceControlEnabled }
          : recent,
      );
    });
  }, [projectService, settingsStore, sourceControlEnabled]);

  // Lock polling and the foreground rescan wait while the app is hidden or a game covers the editor.
  useEffect(() => {
    let hidden = false;
    let rescanPending = false;
    const apply = () => {
      if (hidden || editorQuiet()) {
        sourceControlRef.current.pausePolling();
        return;
      }
      sourceControlRef.current.resumePolling();
      if (!rescanPending) return;
      rescanPending = false;
      void runForegroundRescanRef.current();
    };
    const detachQuiet = subscribeEditorQuiet(apply);
    const detachLifecycle = attachLifecyclePause((paused) => {
      hidden = paused;
      // Coming back to the app rescans the project, once the editor is back too.
      if (!paused) rescanPending = true;
      apply();
    });
    return () => {
      detachQuiet();
      detachLifecycle();
    };
  }, []);


  const ensureDerived = useCallback(async () => {
    if (!derivedStorageRef.current) {
      derivedStorageRef.current = await createDerivedStorage();
    }
    return derivedStorageRef.current;
  }, []);

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

  const recordRecent = useCallback(
    async (
      handle: ProjectFolderHandle | null,
      metadata: ProjectMetadata,
      sourceControl: boolean,
    ) => {
      if (!handle) return;
      await settingsStore.update((settings) => {
        settings.recents = recentProjectsWithOpenedProject(
          settings.recents,
          handle,
          metadata,
          new Date().toISOString(),
          sourceControl,
        );
      });
    },
    [settingsStore],
  );

  const refreshProjectList = useCallback(async () => {
    const fromStorage = await projectService.listProjects();
    const settings = await settingsStore.load();
    setListedProjects(
      listedProjectsFromRecents(settings.recents, fromStorage),
    );
    setNeedsReconnect(await projectService.needsReconnect());
  }, [projectService, settingsStore]);

  // Projects can be deleted outside the editor (e.g. in Files on iPad) while it is in the background.
  useEffect(() => {
    if (route !== "home") return;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshProjectList().catch((error: unknown) => console.warn("[editor] could not refresh the project list", error));
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [route, refreshProjectList]);

  const refreshTemplates = useCallback(async () => {
    setTemplates(await loadTemplateCards());
  }, [setTemplates]);

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
      thumbnailsEnabledRef.current = settings.thumbnailsEnabled !== false;
      setThumbnailsEnabled(settings.thumbnailsEnabled !== false);
    });
    bump();
    return () => {
      mounted = false;
    };
  }, [bump, documentService, refreshProjectList, refreshTemplates, settingsStore]);

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

  /** Set once `closeDocumentsForPaths` exists; reload closes tabs whose file is gone. */
  const closeDocumentsForPathsRef = useRef<(paths: Iterable<string>) => void>(() => {});
  /**
   * Returns the paths whose file could not be read; their tabs keep their
   * content. A tab whose file was deleted on disk closes, as reloading it has
   * nothing to load.
   */
  const reloadDocumentsFromDisk = useCallback(
    async (paths: string[]): Promise<string[]> => {
      const authoring = documentService.getAuthoringLock();
      const failed: string[] = [];
      const deleted: string[] = [];
      if (authoring.readOnly) return failed;
      for (const path of paths) {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.path === path,
        );
        if (!doc || doc.ref.kind === "content-browser") continue;
        try {
          const loaded = await projectService.loadDocument(
            doc.ref.kind,
            doc.ref.path,
          );
          if (documentService.getAuthoringLock() !== authoring) return failed;
          documentService.replaceLoadedContent(
            doc.id,
            editorTabContentForKind(doc.ref.kind, loaded) as NonNullable<typeof doc.content>,
          );
          editSessionRef.current.dropDocument(doc.id);
        } catch (error) {
          const exists = await projectService.documentExists(path).catch(() => true);
          if (documentService.getAuthoringLock() !== authoring) return failed;
          if (!exists) {
            deleted.push(path);
            continue;
          }
          console.warn(`[editor] Could not reload ${path} from disk`, error);
          failed.push(path);
        }
      }
      if (deleted.length > 0) closeDocumentsForPathsRef.current(deleted);
      bump();
      return failed;
    },
    [bump, documentService, projectService],
  );

  const runForegroundRescan = useCallback(async () => {
    if (!projectDocumentRef.current) return;
    const guid = projectService.guid;
    const previous = mtimeSnapshotRef.current;
    await projectService.remountRegistry();
    bump();
    // Another project, or a snapshot an own save took meanwhile, is newer
    // than this scan: classifying against it would report the wrong changes.
    if (projectService.guid !== guid || mtimeSnapshotRef.current !== previous) return;
    const nextAssets = snapshotIndexedMtimes(
      projectService.registry?.list() ?? [],
    );
    // Installed before the project.json read, so the editor's own writes that
    // land meanwhile fold into it; the scan itself is what gets classified.
    const next = { assets: { ...nextAssets }, projectJson: previous?.projectJson ?? null };
    mtimeSnapshotRef.current = next;
    const nextProject = await readProjectJsonMtime(projectService.storagePort);
    if (projectService.guid !== guid || mtimeSnapshotRef.current !== next) return;
    if (previous) {
      const openDocs = documentService
        .getOpenDocumentsOrdered()
        .filter((doc) => doc.ref.kind !== "content-browser")
        .map((doc) => ({ path: doc.ref.path, dirty: doc.dirty }));
      const result = classifyExternalChanges({
        previousAssets: previous.assets,
        nextAssets,
        previousProjectJsonMtime: previous.projectJson,
        nextProjectJsonMtime: nextProject,
        openDocs,
      });
      if (result.kind !== "none") {
        setExternalChangePrompt(result);
      }
    }
    next.projectJson = nextProject;
  }, [bump, documentService, projectService]);
  useLayoutEffect(() => {
    runForegroundRescanRef.current = runForegroundRescan;
  }, [runForegroundRescan]);

  const confirmExternalChangeReloadProject = useCallback(async () => {
    const authoring = documentService.getAuthoringLock();
    if (authoring.readOnly) return;
    const { document } = await projectService.loadCurrentProject();
    if (documentService.getAuthoringLock() !== authoring) return;
    projectSaveState.current.reset(document);
    setProjectDocument(document);
    const paths = documentService
      .getOpenDocumentsOrdered()
      .filter((doc) => doc.ref.kind !== "content-browser")
      .map((doc) => doc.ref.path);
    await reloadDocumentsFromDisk(paths);
    await captureMtimeSnapshot();
    setExternalChangePrompt(null);
  }, [
    captureMtimeSnapshot,
    documentService,
    projectService,
    reloadDocumentsFromDisk,
    setProjectDocument,
  ]);

  const confirmExternalChangeReloadDocs = useCallback(
    async (paths: string[]) => {
      if (documentService.getAuthoringLock().readOnly) return;
      const failed = await reloadDocumentsFromDisk(paths);
      // The next rescan will not report these files again, so the prompt
      // keeps offering the ones that could not be read.
      const keep = (list: string[]) => list.filter((path) => failed.includes(path));
      setExternalChangePrompt((current) => !current || failed.length === 0 ? null : {
        ...current,
        changedPaths: keep(current.changedPaths),
        dirtyChangedPaths: keep(current.dirtyChangedPaths),
        cleanChangedPaths: keep(current.cleanChangedPaths),
      });
    },
    [documentService, reloadDocumentsFromDisk],
  );

  const dismissExternalChange = useCallback(() => {
    setExternalChangePrompt(null);
  }, []);

  const applyPluginOverrides = useCallback(
    async (overrides: Record<string, PluginEnableOverride>) => {
      await projectService.applyPluginOverrides(overrides);
      bump();
    },
    [bump, projectService],
  );

  const deleteProjectPlugin = useCallback(
    async (guid: string) => {
      await projectService.deleteProjectPlugin(guid);
      bump();
    },
    [bump, projectService],
  );

  const exportPlugin = useCallback(
    (guid: string) => projectService.exportPlugin(guid),
    [projectService],
  );

  const importPlugin = useCallback(
    async (bytes: Uint8Array, decision?: "keep" | "replace") => {
      const result = await projectService.importPlugin(bytes, decision);
      bump();
      return result;
    },
    [bump, projectService],
  );

  /**
   * The one rename path: the tab, its undo history, crash-journal lines, Focus
   * state and Anim mode move to the new id together. DocumentService also
   * notifies the project session store (camera, graph pan/zoom, module cards)
   * through `subscribeDocumentIdentity`.
   */
  const repathDocument = useCallback(
    (kind: AssetDocumentKind, oldPath: string, newPath: string) => {
      if (oldPath !== newPath) documentService.assertAuthoringWritable();
      const oldId = documentId({ kind, path: oldPath });
      const wasOpen = oldPath !== newPath && !!documentService.getDocument(oldId);
      // The workspace remounts under the new id; keep its live dock layout.
      if (wasOpen) captureLayoutForId(oldId);
      const moved = documentService.repathDocument(kind, oldPath, newPath);
      if (moved) {
        const { newId } = moved;
        editSessionRef.current.rekeyDocument(oldId, newId);
        const guid = projectService.guid;
        if (wasOpen && guid) {
          // Unsaved edits journalled under the old id replay onto the moved
          // file, together with any later Undo journalled under the new id.
          // The marker goes through the batch buffer so it lands after the
          // buffered edits it renames.
          journalBuffer.append(
            guid,
            journalRepathLine(oldId, newId, new Date().toISOString()),
          );
        }
        moveDockLayouts(oldId, newId);
      }
      bump();
    },
    [
      bump,
      captureLayoutForId,
      documentService,
      journalBuffer,
      moveDockLayouts,
      projectService,
    ],
  );

  const subscribeDocumentIdentity = useCallback(
    (listener: DocumentIdentityListener) =>
      documentService.onIdentityChange(listener),
    [documentService],
  );

  const readProjectDerivedText = useCallback(async (projectGuid: string, name: string) => {
    const storage = await ensureDerived();
    const path = `${derivedDataRoot(projectGuid)}/${name}`;
    return await storage.exists(path) ? storage.readText(path) : null;
  }, [ensureDerived]);

  const writeProjectDerivedText = useCallback(async (projectGuid: string, name: string, text: string) => {
    await (await ensureDerived()).writeText(`${derivedDataRoot(projectGuid)}/${name}`, text);
  }, [ensureDerived]);

  const getOpenDocuments = useCallback(
    () => documentService.getOpenDocumentsOrdered(),
    [documentService],
  );

  const retryFailedTextureEncoding = useCallback(async () => {
    const count = await projectService.retryAllFailedTextureEncoding();
    bump();
    return count;
  }, [bump, projectService]);

  const retryTextureEncoding = useCallback(
    async (
      guid: string,
      options?: { maxDimension?: number; force?: boolean; usage?: string },
    ) => {
      const ok = await requeueWithEditLock(
        sourceControlRef.current,
        projectService.registry?.getByGuid(guid)?.path,
        () => projectService.retryTextureEncoding(guid, options),
      );
      bump();
      return ok;
    },
    [bump, projectService],
  );

  const textureAlignmentStale = useCallback<ProjectService["textureAlignmentStale"]>(
    (guid, usage) => projectService.textureAlignmentStale(guid, usage),
    [projectService],
  );

  const prepareAreaEmission = useCallback<ProjectService["prepareAreaEmission"]>(async (guid, options) => {
    await projectService.prepareAreaEmission(guid, options);
    bump();
  }, [bump, projectService]);

  // Rewrites the Texture file, so a written conversion locks it like a re-encode.
  const reconvertHdrEnvironment = useCallback<ProjectService["reconvertHdrEnvironment"]>(async (guid, faceSize, options) => {
    const written = await requeueWithEditLock(
      sourceControlRef.current,
      projectService.registry?.getByGuid(guid)?.path,
      () => projectService.reconvertHdrEnvironment(guid, faceSize, options),
    );
    bump();
    return written;
  }, [bump, projectService]);

  const onSessionDiagnostic = useCallback(
    (listener: (line: string) => void) => projectService.onDiagnostic(listener),
    [projectService],
  );

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
      thumbnailLruRef.current = new ThumbnailDecodeLru(THUMBNAIL_DECODE_LRU_ENTRIES);
      requestedThumbnailRevisionsRef.current.clear();
      setThumbnailVersions({});
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
      clearPlayPreviewScripts();
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
      clearPlayPreviewScripts,
      cancelSceneDocumentLoad,
      playContent,
      setAnimEditorModes,
      setProjectDocument,
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

  useEffect(() => {
    void ensureEnginePluginStorage();
  }, []);

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
  }, [attachEnginePlugins, enterEditor, projectService, documentTransitions]);

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
    [attachEnginePlugins, enterEditor, projectService, documentTransitions],
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
    [attachEnginePlugins, enterEditor, projectService, documentTransitions],
  );

  const updateListedProject = useCallback(
    async (handle: ProjectFolderHandle, details: UpdateListedProjectOptions) => {
      const trimmed = details.name.trim();
      if (!trimmed) return;
      await projectService.updateListedProject(handle, {
        ...details,
        name: trimmed,
      });
      await settingsStore.update((settings) => {
        settings.recents = settings.recents.map((recent) =>
          recent.id === handle.id
            ? {
                ...recent,
                name: trimmed,
                ...(details.appearance ? { appearance: details.appearance } : {}),
              }
            : recent,
        );
      });
      await refreshProjectList();
    },
    [projectService, refreshProjectList, settingsStore],
  );

  const removeListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      if (shouldDeleteOpfsOnRemove(getHostPlatform(), handle.tier)) {
        await projectService.deleteListedProject(handle);
      }
      await settingsStore.update((settings) => {
        settings.recents = settings.recents.filter(
          (recent) => recent.id !== handle.id,
        );
      });
      await refreshProjectList();
    },
    [projectService, refreshProjectList, settingsStore],
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
  }, [attachEnginePlugins, enterEditor, projectService]);

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
    return enqueueProjectWrite(async () => {
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
    });
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
  }, [projectService, saveProject]);

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
  }, [cancelDebouncedSave, documentService, projectService, scheduleDebouncedSave]);

  useEffect(() => subscribeEditorQuiet(() => {
    if (editorQuiet() || !autoSaveDeferredRef.current) return;
    autoSaveDeferredRef.current = false;
    if (
      projectService.guid &&
      (documentService.getDirtyDocuments().length > 0 || projectSaveState.current.isDirty(projectDocumentRef.current))
    ) {
      scheduleDebouncedSave();
    }
  }), [documentService, projectService, scheduleDebouncedSave]);

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

  const setShowPluginContent = useCallback(
    (show: boolean) => {
      documentService.setShowPluginContent(show);
      scheduleDebouncedSave();
      bumpRegistry();
    },
    [bumpRegistry, documentService, scheduleDebouncedSave],
  );

  const createProjectPlugin = useCallback(
    async (displayName: string) =>
      createProjectPluginAndRevealContent(
        (name) => projectService.createProjectPlugin(name),
        setShowPluginContent,
        displayName,
      ),
    [projectService, setShowPluginContent],
  );

  const releaseSessionsForProjectClose = useCallback(
    async () => documentTransitions.check({ kind: "close-project" }),
    [documentTransitions],
  );

  /** Close Project's prompt when documents or project settings are unsaved. */
  const unsavedProjectWork = useCallback((): CloseProjectResult | null => {
    const dirty = documentService.getDirtyDocuments();
    const projectDirty = projectSaveState.current.isDirty(projectDocumentRef.current);
    return dirty.length > 0 || projectDirty ? { outcome: "unsaved", dirty, projectDirty } : null;
  }, [documentService]);

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
    exclusiveSceneRequest.current += 1;
    setPendingExclusiveScene(null);
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
    clearPlayPreviewScripts();
    playContent.clearCompileCache();
    setRoute("home");
    setAnimEditorModes({});
    mtimeSnapshotRef.current = null;
    setExternalChangePrompt(null);
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
    clearPlayPreviewScripts,
    cancelSceneDocumentLoad,
    playContent,
    resetDockLayouts,
    setAnimEditorModes,
    setPendingExclusiveScene,
    setProjectDocument,
    documentTransitions,
    unsavedProjectWork,
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

  const exportProject = useCallback(async (snapshot?: ProjectDocument) => {
    return projectService.exportZip(snapshot);
  }, [projectService]);

  const exportGameArtifact = useCallback(
    (options?: ExportGameArtifactOptions) =>
      exportProjectGameArtifact(projectService, projectDocumentRef.current, options),
    [projectService],
  );

  const zipExportedGame = useCallback((artifact: ExportArtifact) => {
    return zipGameArtifact(artifact);
  }, []);

  const dismissRecovery = useCallback(async () => {
    const guid = projectService.guid;
    if (guid) {
      // Edits made since the project opened are not part of the offer and stay.
      await discardSealedJournal(await ensureDerived(), guid);
    }
    // The banner belongs to the project open now; another may have opened meanwhile.
    if (projectService.guid === guid) setRecoveryAvailable(false);
  }, [ensureDerived, projectService]);

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

  const performCloseDocument = useCallback(
    (id: string) => {
      documentService.assertDocumentCanClose(id);
      const doc = documentService.getDocument(id);
      const guid = projectService.guid;
      if (doc && doc.ref.kind !== "content-browser" && guid) {
        journalBuffer.append(guid, journalDiscardLine(id, new Date().toISOString()));
      }
      forgetDockLayouts(id);
      documentService.closeDocument(id);
      if (doc?.content && !doc.dirty) {
        // Saved content: a reopen that loads the same content resumes Undo.
        const content = doc.content;
        editSessionRef.current.closeDocument(id, () =>
          documentContentIdentity(content),
        );
      } else {
        // Closing with unsaved edits discards them (the Discard choice), and
        // their history only fits the discarded content.
        editSessionRef.current.dropDocument(id);
      }
      void journalBuffer.flush();
      bump();
    },
    [
      bump,
      documentService,
      forgetDockLayouts,
      journalBuffer,
      projectService,
    ],
  );

  const closeDocument = useCallback((id: string): void => {
    const allowed = documentTransitions.check({ kind: "close-document", documentId: id });
    if (typeof allowed === "boolean") {
      if (allowed) performCloseDocument(id);
    } else {
      void allowed.then(result => { if (result) performCloseDocument(id); })
        .catch(error => { console.error("[editor] document close was refused", error); });
    }
  }, [documentTransitions, performCloseDocument]);

  const closeDocumentsForPaths = useCallback(
    (paths: Iterable<string>) => {
      documentService.assertAuthoringWritable();
      const pathSet = paths instanceof Set ? paths : new Set(paths);
      // The assets are being deleted: their history, open or kept from a
      // closed tab, must not reach a new asset created at the same path.
      for (const path of pathSet) {
        for (const kind of ASSET_DOCUMENT_KINDS) {
          editSessionRef.current.dropDocument(documentId({ kind, path }));
        }
      }
      const ids: string[] = [];
      for (const doc of documentService.getOpenDocumentsOrdered()) {
        if (doc.ref.kind === "content-browser") continue;
        if (pathSet.has(doc.ref.path)) ids.push(doc.id);
      }
      for (const id of ids) performCloseDocument(id);
    },
    [performCloseDocument, documentService],
  );
  useLayoutEffect(() => {
    closeDocumentsForPathsRef.current = closeDocumentsForPaths;
  }, [closeDocumentsForPaths]);

  /**
   * Writes `project.json` now, in the project write queue: a Save All already
   * running finishes first instead of overwriting it with its older document.
   */
  const saveProjectNow = useCallback((next: ProjectDocument) => enqueueProjectWrite(async () => {
    const projectSave = projectSaveState.current.capture(next);
    await projectService.saveProject(next, documentService.buildLayouts());
    await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
    projectSaveState.current.complete(projectSave);
  }), [captureMtimeSnapshot, documentService, enqueueProjectWrite, projectService]);

  const replaceClassReferencesBeforeDelete = useCallback(async (
    replacements: readonly ClassAssetReplacement[],
    deletingGuids: ReadonlySet<string>,
    onProgress?: (currentName: string) => Promise<void>,
  ) => {
    const registry = projectService.registry;
    const schemas = collectGraphTypeSchemas();
    const definitionFields = (guid: string) => schemas.structs?.[guid]?.fields;
    const openChanges = documentService.getOpenDocumentsOrdered().flatMap((doc) => {
      if (doc.ref.kind === "content-browser" || doc.ref.kind === "trace" || !doc.content) return [];
      const asset = registry?.list().find((entry) => entry.path === doc.ref.path);
      if (asset && deletingGuids.has(asset.header.guid)) return [];
      const walked = replaceClassAssetReferences(doc.content, replacements, definitionFields);
      if (!walked.changed) return [];
      if ((asset && registry?.getRoot(asset.rootId)?.readOnly) || isPluginDocumentReadOnly(projectService.plugins, doc.ref.path)) {
        throw new Error(`${doc.ref.path} is read-only and still references a selected Class.`);
      }
      return [{ doc, content: walked.value }];
    });
    await projectService.replaceClassReferencesBeforeDelete(replacements, deletingGuids, onProgress);
    // The referrer files now name the replacement. Open tabs follow at once,
    // from their current content, so a failed Project Settings write below
    // cannot leave a tab whose next Save writes the old reference back.
    for (const { doc } of openChanges) {
      const open = documentService.getDocument(doc.id);
      if (!open?.content) continue;
      const walked = replaceClassAssetReferences(open.content, replacements, definitionFields);
      if (!walked.changed) continue;
      documentService.applyFileRewrite(open.id, walked.value);
    }
    bump();
    const current = projectDocumentRef.current;
    if (current) {
      const settings = replaceClassAssetReferences(current.settings, replacements);
      if (settings.changed) {
        await onProgress?.("Project Settings");
        const next = { ...current, settings: settings.value };
        await saveProjectNow(next);
        setProjectDocument(next);
      }
    }
  }, [bump, collectGraphTypeSchemas, documentService, projectService, saveProjectNow, setProjectDocument]);

  const renameAsset = useCallback((guid: string, newName: string) => enqueueProjectWrite(async () => {
    cancelDebouncedSave();
    try {
      const registry = projectService.registry;
      const before = registry?.getByGuid(guid);
      if (!registry || !before) throw new Error("The asset is unavailable.");
      const nextPath = renamedAssetPath(before.path, newName);
      const replacements: ClassAssetReplacement[] = before.header.type === "Class"
        ? [{ guid, classId: classIdFromClassAsset(before), replacement: { guid, classId: classIdFromClassAsset({ ...before, path: nextPath }) } }]
        : [];
      const schemas = collectGraphTypeSchemas();
      const openChanges = documentService.getOpenDocumentsOrdered().flatMap((doc) => {
        if (!doc.content || doc.ref.kind === "content-browser" || doc.ref.kind === "trace") return [];
        const walked = replaceClassAssetReferences(doc.content, replacements, (definitionGuid) => schemas.structs?.[definitionGuid]?.fields);
        if (!walked.changed) return [];
        const asset = registry.list().find((entry) => entry.path === doc.ref.path);
        if ((asset && registry.getRoot(asset.rootId)?.readOnly) || isPluginDocumentReadOnly(projectService.plugins, doc.ref.path)) {
          throw new Error(`${doc.ref.path} is read-only and still references this Class.`);
        }
        return [{ doc, content: walked.value }];
      });
      const renamed = await projectService.renameAsset(guid, newName, {
        beforeWrite: async (paths) => {
          for (const path of new Set([...paths, ...openChanges.map(({ doc }) => doc.ref.path)])) {
            const error = sourceControlRef.current.refuseIfTheirs(path);
            if (error) throw new Error(error);
          }
          const projectGuid = projectService.guid;
          if (!projectGuid || openChanges.length === 0) return;
          const at = new Date().toISOString();
          for (const { doc } of openChanges) {
            const checkpoint = journalCheckpointLine(doc.id, doc.content, at);
            checkpoint.command.assetGuid = registry.getByPath(doc.ref.path)?.header.guid;
            checkpoint.command.classReferences = replacements.map(({ guid: classGuid, classId }) => ({ guid: classGuid, classId }));
            journalBuffer.append(projectGuid, checkpoint);
          }
          // Snapshots still name the old Class. Recovery resolves GUIDs against
          // disk, so a failed rename cannot leave rewritten recovery content.
          await journalBuffer.flush(projectGuid, { rejectOnError: true });
        },
      });
      // The rename moved files and may have rewritten project.json: neither is external.
      await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
      for (const { doc, content } of openChanges) {
        documentService.applyFileRewrite(doc.id, content);
        // Content Browser file operations are not undoable. Old edit commands
        // must not reintroduce the Class id that no longer exists.
        editSessionRef.current.dropDocument(doc.id);
      }
      // The registry stamped the file's payload name; an open tab follows it.
      for (const doc of documentService.getOpenDocumentsOrdered()) {
        if (doc.ref.path === before.path) documentService.applyAssetRename(doc.id, renamed.header.name);
      }
      const current = projectDocumentRef.current;
      if (current && replacements.length) {
        const settings = replaceClassAssetReferences(current.settings, replacements);
        if (settings.changed) setProjectDocument({ ...current, settings: settings.value });
      }
      bump();
      return renamed;
    } finally {
      if (documentService.getDirtyDocuments().length || projectSaveState.current.isDirty(projectDocumentRef.current)) scheduleDebouncedSave();
    }
  }), [bump, cancelDebouncedSave, captureMtimeSnapshot, collectGraphTypeSchemas, documentService, enqueueProjectWrite, journalBuffer, projectService, scheduleDebouncedSave, setProjectDocument]);

  const repairAfterAssetDelete = useCallback(
    async (
      deletedGuids: ReadonlySet<string>,
      deletedClassNames: ReadonlySet<string> = new Set(),
      onProgress?: (currentName: string) => Promise<void>,
      deletedFolders: readonly string[] = [],
    ) => {
      const schemas = collectGraphTypeSchemas();
      const definitionFields = (guid: string) => schemas.structs?.[guid]?.fields;
      const unrepaired = await projectService.clearDeletedAssetReferences(deletedGuids, {
        deletedClassNames,
        onProgress,
      });
      for (const doc of documentService.getOpenDocumentsOrdered()) {
        if (doc.ref.kind === "content-browser" || !doc.content) continue;
        await onProgress?.(doc.ref.path);
        const walked = clearDeletedAssetRefs(
          doc.content,
          deletedGuids,
          deletedClassNames,
          definitionFields,
        );
        if (!walked.changed) continue;
        documentService.applyFileRewrite(doc.id, walked.value);
      }
      const current = projectDocumentRef.current;
      await onProgress?.("Refreshing Assets");
      await projectService.remountRegistry();
      const paths = projectService.registry?.listDocumentPaths({
        rootId: "project",
      });
      if (current) {
        await onProgress?.("Saving Project");
        const cleared = clearDeletedRefsFromProjectSettings(
          current.settings,
          deletedGuids,
          deletedClassNames,
        ).value;
        const settings = {
          ...cleared,
          alwaysPackageFolders: removeAlwaysPackageFolders(cleared.alwaysPackageFolders, deletedFolders),
        };
        const next = {
          ...current,
          settings,
          ...(paths ? { scenes: paths.scenes, graphs: paths.graphs } : {}),
        };
        setProjectDocument(next);
        captureAllLayouts();
        await saveProjectNow(next);
      }
      bump();
      // Everything else is repaired first; the delete then reports what was not.
      if (unrepaired.length > 0) {
        const cause = unrepaired[0]!.error;
        throw new Error(
          `References to the deleted assets remain in ${unrepaired.map((entry) => entry.path).join(", ")}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    },
    [
      bump,
      captureAllLayouts,
      collectGraphTypeSchemas,
      documentService,
      projectService,
      saveProjectNow,
      setProjectDocument,
    ],
  );

  /**
   * Opening a Scene closes every other open Scene. Each one it replaces goes
   * through the gate, so a session playing or simulating it stops first.
   */
  const checkSceneReplacement = useCallback((ref: DocumentRef): boolean | Promise<boolean> => {
    const nextId = documentId(ref);
    const replaced = documentService.getOpenDocumentsOrdered()
      .filter((doc) => doc.ref.kind === "scene" && doc.id !== nextId);
    const next = (index: number): boolean | Promise<boolean> => {
      for (let cursor = index; cursor < replaced.length; cursor++) {
        const allowed = documentTransitions.check({ kind: "replace-document", documentId: replaced[cursor]!.id });
        if (allowed === false) return false;
        if (allowed !== true) return allowed.then((ok) => ok && next(cursor + 1));
      }
      return true;
    };
    return next(0);
  }, [documentService, documentTransitions]);

  /** `discardDirtyScenes`: the user chose Discard, so replaced Scenes close even when dirty. */
  const finishOpenDocument = useCallback(
    async (ref: DocumentRef, options?: { discardDirtyScenes?: boolean }) => {
      // Taken before the session gate's wait, so a tab picked during it stays active.
      const request = ++activationRequest.current;
      if (ref.kind === "scene" && !documentService.getDocument(documentId(ref))) {
        const allowed = checkSceneReplacement(ref);
        if (allowed === false || (typeof allowed !== "boolean" && !await allowed)) return;
        // A stopped session can leave a replaced Scene dirty (Simulation's
        // Keep Changes); ask to Save or Discard it instead of closing it.
        if (!options?.discardDirtyScenes &&
          dirtyScenesBlockingOpen(documentService.getDirtyDocuments(), documentId(ref)).length > 0) {
          setPendingExclusiveScene(ref);
          return;
        }
      }
      const controller = isSceneWorkspaceKind(ref.kind) ? new AbortController() : null;
      if (controller) {
        cancelSceneDocumentLoad();
        sceneDocumentLoadRef.current = controller;
      }
      const { activeDocumentId } = documentService.getState();
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      const layouts = documentService.buildLayouts();
      const layout = layouts.documents[documentId(ref)] ?? null;
      try {
        await documentService.openDocument(projectService, ref, layout, () => activationRequest.current === request, controller ? {
          signal: controller.signal,
          beforeLoad: async () => {
            setSceneDocumentLoad({ ref, failed: false });
            await waitForSceneLoadingPaint(controller.signal);
          },
          beforeCommit: () => {
            if (ref.kind !== "scene") return;
            // Keep the old scene and its edit session until replacement I/O succeeds.
            const nextId = documentId(ref);
            const others = documentService.getOpenDocumentsOrdered()
              .filter((doc) => doc.ref.kind === "scene" && doc.id !== nextId);
            for (const other of others) performCloseDocument(other.id);
          },
        } : undefined);
      } catch (error) {
        if (controller?.signal.aborted) return;
        if (!controller) throw error;
        console.error("[editor] failed to open scene document", error);
        setSceneDocumentLoad({ ref, failed: true, error });
        return;
      }
      if (controller?.signal.aborted) return;
      if (controller && sceneDocumentLoadRef.current === controller) {
        sceneDocumentLoadRef.current = null;
        setSceneDocumentLoad(null);
      }
      if (ref.kind === "scene") {
        emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.sceneOpen);
      }
      sourceControlRef.current.onOpenDocument(ref.path);
      bump();
      if (ref.kind === "scene") {
        await editing.syncPrefabInstances({ quiet: true });
      }
    },
    [bump, captureLayoutForId, checkSceneReplacement, editing, performCloseDocument, documentService, projectService, cancelSceneDocumentLoad, setPendingExclusiveScene],
  );

  const ensureAssetDocument = useCallback(async (ref: DocumentRef): Promise<string> => {
    if (!isAssetDocumentKind(ref.kind) || isSceneWorkspaceKind(ref.kind)) {
      throw new Error("Only non-scene asset documents can be opened in the background.");
    }
    const layouts = documentService.buildLayouts();
    const id = await documentService.openDocument(
      projectService, ref, layouts.documents[documentId(ref)] ?? null, false, { background: true },
    );
    sourceControlRef.current.onOpenDocument(ref.path);
    bump();
    return id;
  }, [bump, documentService, projectService]);

  const openDocument = useCallback(
    async (ref: DocumentRef) => {
      if (ref.kind === "scene") {
        exclusiveSceneRequest.current += 1;
        const blocking = dirtyScenesBlockingOpen(
          documentService.getDirtyDocuments(),
          documentId(ref),
        );
        if (blocking.length > 0) {
          // The session gate runs once the user chooses Save or Discard, so
          // Cancel leaves a running session untouched.
          setPendingExclusiveScene(ref);
          return;
        }
      }
      // A Scene's replace-document gate runs in finishOpenDocument.
      await finishOpenDocument(ref);
    },
    [documentService, finishOpenDocument, setPendingExclusiveScene],
  );

  const openRecordedTrace = useCallback(
    async (payload: TracePayload, options: { keep?: number } = {}) => {
      const guid = projectService.guid;
      if (!guid) return;
      const derived = await ensureDerived();
      projectService.setDerivedStorage(derived);
      const fileName = recordedTraceFileName(Date.now());
      const spilled = await spillRecordedTraceDocument({
        derivedStorage: derived,
        projectGuid: guid,
        payload,
        fileName,
        documentGuid: newAssetGuid(),
      });
      await finishOpenDocument(spilled.ref);
      if (options.keep === undefined) return;
      const open = new Set(
        [...documentService.getState().openDocuments.values()]
          .flatMap((document) => (document.ref.kind === "trace" ? [document.ref.path] : [])),
      );
      open.add(spilled.path);
      await pruneTraceDocuments(derived, guid, options.keep, open);
    },
    [documentService, ensureDerived, finishOpenDocument, projectService],
  );

  const listRecentTraces = useCallback(async () => {
    const guid = projectService.guid;
    return guid ? listTraceDocuments(await ensureDerived(), guid) : [];
  }, [ensureDerived, projectService]);

  const openTraceDocument = useCallback(
    async (path: string) => {
      // A Trace tab reads its document from the derived storage.
      projectService.setDerivedStorage(await ensureDerived());
      await finishOpenDocument(createDocumentRef("trace", path));
    },
    [ensureDerived, finishOpenDocument, projectService],
  );

  const confirmExclusiveSceneOpen = useCallback(
    async (mode: "save" | "discard") => {
      // Written by openDocument's setter, so a request made earlier in the
      // same event is already visible here.
      const ref = pendingExclusiveSceneRef.current;
      if (!ref) return;
      // Cancel, or a newer open request, while the gate or Save awaits ends this one.
      const request = exclusiveSceneRequest.current;
      const allowed = checkSceneReplacement(ref);
      if (allowed === false || (typeof allowed !== "boolean" && !await allowed)) return;
      if (request !== exclusiveSceneRequest.current) return;
      if (mode === "save") {
        const saved = await saveAll();
        if (!saved || request !== exclusiveSceneRequest.current ||
          dirtyScenesBlockingOpen(documentService.getDirtyDocuments(), documentId(ref)).length > 0) return;
      }
      setPendingExclusiveScene(null);
      await finishOpenDocument(ref, { discardDirtyScenes: mode === "discard" });
    },
    [checkSceneReplacement, documentService, finishOpenDocument, saveAll, setPendingExclusiveScene],
  );

  const cancelExclusiveSceneOpen = useCallback(() => {
    exclusiveSceneRequest.current += 1;
    setPendingExclusiveScene(null);
  }, [setPendingExclusiveScene]);

  const setActiveDocument = useCallback(
    (id: string) => {
      activationRequest.current += 1;
      const { activeDocumentId } = documentService.getState();
      if (id === activeDocumentId) return;
      const target = documentService.getState().openDocuments.get(id);
      if (target?.content === null && target.ref.kind !== "content-browser") {
        void finishOpenDocument(target.ref);
        return;
      }
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      documentService.setActiveDocument(id);
      bump();
    },
    [bump, captureLayoutForId, documentService, finishOpenDocument],
  );

  const reorderClosableTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      documentService.reorderClosableTabs(fromIndex, toIndex);
      bump();
    },
    [bump, documentService],
  );

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      documentService.reorderTabs(fromIndex, toIndex);
      bump();
    },
    [bump, documentService],
  );

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

  const prefillSourceControlFromGit = useCallback(async () => {
    return readGitPrefill(projectService.storagePort);
  }, [projectService]);

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
      // The graph signature does not cover the header's parent, so Compile and
      // Play's stored bundles would otherwise keep the previous parent.
      setLastCompiledSignature(null);
      clearPlayPreviewScripts();
      bump();
      return null;
    },
    [bump, clearPlayPreviewScripts, documentService, editing, projectService],
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

  const textureUsageBlockedReason = useCallback(
    (guid: string): string | null => {
      const registry = projectService.registry;
      const asset = registry?.getByGuid(guid);
      if (!asset || asset.header.type !== "Texture") return null;
      if (
        registry?.getRoot(asset.rootId)?.readOnly ||
        isPluginDocumentReadOnly(projectService.plugins, asset.path)
      ) {
        return "The Texture is read-only.";
      }
      const sourceControl = sourceControlRef.current;
      const open = documentService
        .getState()
        .openDocuments.get(documentId({ kind: "texture", path: asset.path }));
      // An open tab follows its lock banner (Edit Anyway lifts it); a closed
      // Texture refuses another user's lock, as Content Browser moves do.
      if (
        sourceControl.isDocumentReadOnly(asset.path) ||
        (!open?.content && sourceControl.refuseIfTheirs(asset.path))
      ) {
        const owner = sourceControl.lockForPath(asset.path)?.ownerName;
        return owner ? `The Texture is locked by ${owner}.` : "The Texture is locked.";
      }
      return null;
    },
    [documentService, projectService],
  );

  // An open Texture tab's Usage may be an unsaved Details edit that already
  // re-encoded; the texture alignment pass must not undo it with the saved Usage.
  useEffect(() => {
    projectService.setOpenTextureUsage((guid) => {
      const asset = projectService.registry?.getByGuid(guid);
      if (!asset) return undefined;
      const open = documentService
        .getState()
        .openDocuments.get(documentId({ kind: "texture", path: asset.path }));
      const usage = (open?.content as { usage?: unknown } | null | undefined)?.usage;
      return typeof usage === "string" ? usage : undefined;
    });
    return () => projectService.setOpenTextureUsage(null);
  }, [documentService, projectService]);

  const createAssetLoadScope = useCallback(
    (owner: string) => projectService.createAssetLoadScope(owner),
    [projectService],
  );

  const getAssetLoadState = useCallback(
    (guid: string): AssetLoadState => projectService.registry
      ? projectService.assetLoadingService.getLoadState(guid)
      : "unloaded",
    [projectService],
  );

  const writeSceneNavmeshChunk = useCallback(
    (path: string, bytes: Uint8Array, payload: Record<string, unknown>) =>
      projectService.writeSceneNavmeshChunk(path, bytes, payload),
    [projectService],
  );

  const writeSceneAudioReverbChunk = useCallback(
    (path: string, bytes: Uint8Array, payload: Record<string, unknown>) =>
      projectService.writeSceneAudioReverbChunk(path, bytes, payload),
    [projectService],
  );

  const writeAudioClipChunk = useCallback(
    (
      path: string,
      chunkId: string,
      bytes: Uint8Array,
      mime: string,
      payload: Record<string, unknown>,
    ) => projectService.writeAudioClipChunk(path, chunkId, bytes, mime, payload),
    [projectService],
  );

  const removeAudioClipChunk = useCallback(
    (path: string, chunkId: string, payload: Record<string, unknown>) =>
      projectService.removeAudioClipChunk(path, chunkId, payload),
    [projectService],
  );

  const loadAssetDocument = useCallback(
    async (
      kind: AssetDocumentKind,
      path: string,
    ): Promise<unknown | null> => {
      const openDoc = documentService
        .getState()
        .openDocuments.get(documentId({ kind, path }));
      if (openDoc?.content) return openDoc.content;
      try {
        return await projectService.loadDocument(kind, path, {
          scope: documentService.getAssetLoadScope(documentService.getState().activeDocumentId ?? ""),
        });
      } catch (error) {
        console.error(`[editor] failed to load ${kind} ${path}`, error);
        return null;
      }
    },
    [documentService, projectService],
  );

  const loadGraphDocument = useCallback(
    async (path: string): Promise<SerializedGraph | null> => {
      const openDoc = documentService
        .getState()
        .openDocuments.get(documentId({ kind: "graph", path }));
      if (openDoc?.content) return openDoc.content as SerializedGraph;
      try {
        return (await projectService.loadDocument(
          "graph",
          path,
        )) as SerializedGraph;
      } catch (error) {
        console.error(`[place] failed to load class ${path}`, error);
        return null;
      }
    },
    [documentService, projectService],
  );

  const loadAssetThumbnail = useCallback(
    async (assetGuid: string): Promise<Uint8Array | null> => {
      if (!thumbnailsEnabledRef.current) return null;
      // A read that finishes after a project switch fills the old cache only.
      const lru = thumbnailLruRef.current;
      const guid = projectService.guid;
      if (!guid) return null;
      const asset = projectService.registry?.getByGuid(assetGuid);
      const revisionIndex = thumbnailRevisionIndexRef.current;
      const revision = revisionIndex.revision(assetGuid);
      if (revision !== null) {
        const requested = requestedThumbnailRevisionsRef.current;
        requested.delete(assetGuid);
        requested.set(assetGuid, revision);
        if (requested.size > 512) requested.delete(requested.keys().next().value!);
      }
      else if (asset?.header.type === "Class") return null;
      const key = revision !== null ? await revisionIndex.cacheKey(assetGuid) : assetGuid;
      if (!key || projectService.guid !== guid || thumbnailLruRef.current !== lru ||
        thumbnailRevisionIndexRef.current.revision(assetGuid) !== revision) return null;
      const cached = lru.get(key);
      if (cached) return cached;
      const derived = await ensureDerived();
      const bytes = await readThumbnail(derived, guid, key);
      if (projectService.guid !== guid || thumbnailLruRef.current !== lru ||
        thumbnailRevisionIndexRef.current.revision(assetGuid) !== revision) return null;
      if (bytes) lru.set(key, bytes);
      // Browsing may read derived thumbnails but never trigger source loading.
      // Explicit import/save operations schedule generation separately.
      return bytes;
    },
    [ensureDerived, projectService],
  );

  const writeAssetThumbnail = useCallback(
    async (assetGuid: string, bytes: Uint8Array, expected?: AssetThumbnailWriteIdentity): Promise<void> => {
      const guid = projectService.guid;
      if (!guid || (expected && expected.projectGuid !== guid)) return;
      const lru = thumbnailLruRef.current;
      const derived = await ensureDerived();
      const revisionIndex = createAssetThumbnailRevisionIndex(projectService.registry?.list() ?? [], projectDocumentRef.current?.settings.twoD.pixelsPerUnit);
      const revision = revisionIndex.revision(assetGuid);
      const key = revision !== null ? await revisionIndex.cacheKey(assetGuid) : assetGuid;
      if (!key || projectService.guid !== guid || thumbnailLruRef.current !== lru ||
        (expected && expected.cacheKey !== key)) return;
      await writeThumbnail(derived, guid, key, bytes);
      if (projectService.guid !== guid || thumbnailLruRef.current !== lru) return;
      lru.delete(key);
      setThumbnailVersions((versions) => ({
        ...versions,
        [assetGuid]: (versions[assetGuid] ?? 0) + 1,
      }));
    },
    [ensureDerived, projectService],
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
  ]);

  const undoActiveDocument = useCallback(() => {
    editing.stepHistory("undo");
  }, [editing]);

  const redoActiveDocument = useCallback(() => {
    editing.stepHistory("redo");
  }, [editing]);


  // Every callback above keeps its identity for the provider's lifetime (the
  // state it reads lives in refs or services), so this object is created once
  // and action-only consumers never re-render when documents change.
  const actions = useMemo<DocumentActions>(
    () => ({
      lockAuthoring,
      beginSimulationDocument,
      getAuthoringLock,
      subscribeAuthoringLock,
      lockAuthoringWrites,
      registerBeforeTransition,
      withSceneWrite,
      refreshAssetRegistry,
      noteAssetsCreated,
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin,
      deleteProjectPlugin,
      exportPlugin,
      importPlugin,
      repathDocument,
      repathProjectFolder,
      renameAsset,
      subscribeDocumentIdentity,
      readProjectDerivedText,
      writeProjectDerivedText,
      retryFailedTextureEncoding,
      prepareAreaEmission,
      reconvertHdrEnvironment,
      collectPlayAreaEmissions,
      retryTextureEncoding,
      textureAlignmentStale,
      textureUsageBlockedReason,
      onSessionDiagnostic,
      getOpenDocuments,
      refreshTemplates,
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      updateListedProject,
      removeListedProject,
      reconnectProject,
      saveProject,
      setAutoSavePaused,
      saveAll,
      approveMigrationsAndSave,
      closeProject,
      releaseSessionsForProjectClose,
      forceCloseProject,
      exportProject,
      exportGameArtifact,
      zipExportedGame,
      dismissRecovery,
      keepRecovery,
      openDocument,
      ensureAssetDocument,
      openRecordedTrace,
      listRecentTraces,
      openTraceDocument,
      confirmExclusiveSceneOpen,
      cancelExclusiveSceneOpen,
      closeDocument,
      closeDocumentsForPaths,
      replaceClassReferencesBeforeDelete,
      repairAfterAssetDelete,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
      applyGraphChange,
      reparentClassDocument,
      applySceneChange,
      applyAssetDocumentChange,
      createAssetLoadScope,
      getAssetLoadState,
      readAssetChunk,
      writeAudioClipChunk,
      removeAudioClipChunk,
      writeSceneNavmeshChunk,
      writeSceneAudioReverbChunk,
      updateProjectVersion,
      updateProjectSettings,
      prefillSourceControlFromGit,
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
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
      loadAssetThumbnail,
      writeAssetThumbnail,
      collectPlayPreviewScripts,
      collectEditorUtilityScripts,
      loadAssetDocument,
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
      loadGraphDocument,
    }),
    [
      lockAuthoring,
      beginSimulationDocument,
      getAuthoringLock,
      subscribeAuthoringLock,
      lockAuthoringWrites,
      registerBeforeTransition,
      withSceneWrite,
      refreshAssetRegistry,
      noteAssetsCreated,
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin,
      deleteProjectPlugin,
      exportPlugin,
      importPlugin,
      repathDocument,
      repathProjectFolder,
      renameAsset,
      subscribeDocumentIdentity,
      readProjectDerivedText,
      writeProjectDerivedText,
      retryFailedTextureEncoding,
      prepareAreaEmission,
      reconvertHdrEnvironment,
      collectPlayAreaEmissions,
      retryTextureEncoding,
      textureAlignmentStale,
      textureUsageBlockedReason,
      onSessionDiagnostic,
      getOpenDocuments,
      refreshTemplates,
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      updateListedProject,
      removeListedProject,
      reconnectProject,
      saveProject,
      setAutoSavePaused,
      saveAll,
      approveMigrationsAndSave,
      closeProject,
      releaseSessionsForProjectClose,
      forceCloseProject,
      exportProject,
      exportGameArtifact,
      zipExportedGame,
      dismissRecovery,
      keepRecovery,
      openDocument,
      ensureAssetDocument,
      openRecordedTrace,
      listRecentTraces,
      openTraceDocument,
      confirmExclusiveSceneOpen,
      cancelExclusiveSceneOpen,
      closeDocument,
      closeDocumentsForPaths,
      replaceClassReferencesBeforeDelete,
      repairAfterAssetDelete,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
      applyGraphChange,
      reparentClassDocument,
      applySceneChange,
      applyAssetDocumentChange,
      createAssetLoadScope,
      getAssetLoadState,
      readAssetChunk,
      writeAudioClipChunk,
      removeAudioClipChunk,
      writeSceneNavmeshChunk,
      writeSceneAudioReverbChunk,
      updateProjectVersion,
      updateProjectSettings,
      prefillSourceControlFromGit,
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
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
      loadAssetThumbnail,
      writeAssetThumbnail,
      collectPlayPreviewScripts,
      collectEditorUtilityScripts,
      loadAssetDocument,
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
      loadGraphDocument,
    ],
  );

  // Every service mutation is followed by a context update, so reading the
  // revisions on each provider render sees the latest ones.
  const documentRevisions = documentService.getRevisions();
  const tabsRevision = documentService.getTabsRevision();
  const tabOrderRef = useRef<string[]>([]);
  const tabOrder = useMemo(() => {
    void tabsRevision;
    const next = documentService.getState().tabOrder;
    const previous = tabOrderRef.current;
    // Switching tabs advances the tabs revision without moving any tab.
    if (
      previous.length === next.length &&
      previous.every((id, index) => id === next[index])
    ) {
      return previous;
    }
    const copy = [...next];
    tabOrderRef.current = copy;
    return copy;
  }, [documentService, tabsRevision]);
  // Entries are mutated in place, so these follow the revisions rather than
  // entry identity; registry-only and other unrelated updates keep them.
  const openDocuments = useMemo(() => {
    void documentRevisions;
    void tabOrder;
    return documentService.getOpenDocumentsOrdered();
  }, [documentRevisions, documentService, tabOrder]);
  const dirtyDocuments = useMemo(() => {
    void documentRevisions;
    return documentService.getDirtyDocuments();
  }, [documentRevisions, documentService]);
  // The save slice keeps its list while the same documents, with the same
  // labels, are dirty: a second edit of a dirty document does not change it.
  const stableDirtyRef = useRef<{ list: OpenDocument[]; refs: DocumentRef[] }>({ list: [], refs: [] });
  const stableDirtyDocuments = useMemo(() => {
    const previous = stableDirtyRef.current;
    if (
      previous.list.length === dirtyDocuments.length &&
      dirtyDocuments.every((doc, index) => doc === previous.list[index] && sameDocumentRef(doc.ref, previous.refs[index]))
    ) {
      return previous.list;
    }
    stableDirtyRef.current = { list: dirtyDocuments, refs: dirtyDocuments.map((doc) => doc.ref) };
    return dirtyDocuments;
  }, [dirtyDocuments]);
  const graphSignatureRevision = documentKindsRevision(
    documentRevisions,
    GRAPH_SIGNATURE_KINDS,
  );
  const currentGraphSignature = useMemo(() => {
    void graphSignatureRevision;
    void registryEpoch;
    return playContent.graphSignature(projectDocument?.settings.tags);
  }, [graphSignatureRevision, playContent, projectDocument?.settings.tags, registryEpoch]);

  // Narrow subscriptions: per-document hooks read the service through this
  // store, and every commit (each service mutation is followed by one) lets
  // them compare their snapshots in the same frame as the facade below.
  const subscriptions = useMemo(() => new DocumentSubscriptions(documentService), [documentService]);
  useLayoutEffect(() => {
    subscriptions.publish();
  });

  // Service state read on each render: every service mutation is followed by
  // a context update. The slices below change only when their fields do.
  const activeId = documentService.getState().activeDocumentId;
  const activeDoc = activeId ? documentService.getDocument(activeId) : undefined;
  const activeStack = activeId ? editSessionRef.current.getStack(activeId) : null;
  const authoringReadOnly = documentService.getAuthoringLock().readOnly;
  const sceneMode = parseSceneDocumentLayout(activeDoc?.layout).sceneMode;
  const focusKey =
    activeId && activeDoc?.ref.kind === "scene"
      ? dockviewApiKey(activeId, sceneMode)
      : activeId;
  const animEditorMode = activeId
    ? animEditorModeForDocument(activeId, animEditorModes, activeDoc)
    : "stateMachine";
  const isLayoutFocused = focusKey ? focusedLayoutIds.has(focusKey) : false;
  const canUndoActiveDocument = !authoringReadOnly && (activeStack?.canUndo ?? false);
  const canRedoActiveDocument = !authoringReadOnly && (activeStack?.canRedo ?? false);
  const activeDocumentState = useMemo<ActiveDocumentState>(
    () => ({
      activeDocumentId: activeId,
      animEditorMode,
      sceneMode,
      isLayoutFocused,
      canUndoActiveDocument,
      canRedoActiveDocument,
    }),
    [activeId, animEditorMode, sceneMode, isLayoutFocused, canUndoActiveDocument, canRedoActiveDocument],
  );
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
      scriptsStale: playBundlesNeedCollect({
        playLoadedSignature,
        currentGraphSignature,
        scriptsLength: playPreviewBundles.length,
        editorCompileSignature: lastCompiledSignature,
      }),
      playPreviewBundles,
      playPreviewDiagnostics,
      playLoadedSignature,
    }),
    [currentGraphSignature, lastCompiledSignature, playLoadedSignature, playPreviewBundles, playPreviewDiagnostics],
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
  const sourceControlState = useMemo<SourceControlState>(() => {
    void sourceControlTick;
    return { sourceControl: sourceControlRef.current };
  }, [sourceControlTick]);

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
