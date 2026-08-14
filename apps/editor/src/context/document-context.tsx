import type { DockviewApi } from "dockview-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AssetDocumentKind,
  DocumentRef,
  ProjectDocument,
  ProjectFolderHandle,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import { documentId, isAssetDocumentKind, normalizeProjectSettings, normalizeScene } from "@babylonslate/core";
import {
  appendJournalLine,
  getTile,
  hasJournal,
  normalizeTilemapPayload,
  readJournalLines,
  readThumbnail,
  ThumbnailDecodeLru,
  truncateJournal,
  type AssetRegistry,
  type MigrationPending,
  type ProjectSearchIndex,
  type ProjectTemplate,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import {
  commandToJournalPayload,
  DEFAULT_EDIT_BYTE_BUDGET,
  diffGraphCommands,
  diffSceneCommands,
  EditSession,
  replayJournalLines,
  serializeJournalLine,
  SetAssetDocumentCommand,
} from "@babylonslate/edit";
import {
  createAppSettingsStore,
  createDerivedStorage,
  createStorage,
  createTemplateStorage,
  defaultEngineSettings,
  getHostPlatform,
  isTestModeEnabled,
} from "@babylonslate/vfs";
import type { ProjectStorage } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import {
  DocumentService,
  type OpenDocument,
} from "../services/document-service";
import { ProjectService } from "../services/project-service";
import { dirtyScenesBlockingOpen } from "../lib/exclusive-scene";
import { notifyDocumentEdited } from "../lib/notify-document-edited";
import { loadTemplateCards } from "../services/template-service";
import type { CreateProjectOptions } from "../lib/create-project";
import {
  compileGraphDocuments,
  graphCompileSignature,
  graphsNeedCompile as compileSignatureIsStale,
} from "../services/script-compiler";
import { validateSerializedGraph } from "../services/graph-validation";
import { applyFocusLayout } from "../shell/layout-ops";
import {
  capturePanelPlacement,
  isDockWindowOpen as isDockWindowOpenOnApi,
  listDockPanels,
  toggleDockWindow as toggleDockWindowOnApi,
  type DockWindowApi,
} from "../shell/dock-window-ops";
import { isDockviewDocumentKind } from "../shell/window-catalog";
import {
  editorUtilityAssetsFromIndexed,
  findDockOrUtilityWindow,
} from "../shell/editor-utility-windows";
import {
  classDocumentShowsPrefab,
  classParentLookup,
} from "../lib/content-browser-helpers";
import {
  listedProjectsFromRecents,
  type ListedProject,
} from "../lib/listed-projects";
import {
  EDITOR_UTILITY_EVENTS,
  emitEditorUtilityLifecycle,
  selectEditorUtilityGraphs,
} from "../lib/editor-utility-scripts";
import {
  animationGraphGuidsFromScene,
  behaviourTreeGuidsFromScene,
  blackboardGuidsFromScene,
  mergePlayAnimGraphs,
  mergePlayBehaviourTrees,
  mergePlayBlackboards,
  playAnimGraphsFromGuids,
  playAnimGraphsFromOpenDocuments,
  playBehaviourTreesFromGuids,
  playBehaviourTreesFromOpenDocuments,
  playBlackboardsFromGuids,
  playBlackboardsFromOpenDocuments,
  playSpritePayloadsFromGuids,
  playTilemapPayloadsFromGuids,
  playTilesetPayloadsFromGuids,
  playUiLibraryFromAssets,
  collectPlayScriptDocuments,
  spriteAssetGuidsFromScene,
  tilemapAssetGuidsFromScene,
  tilesetGuidsFromTilemaps,
  textureGuidsFromPlayPayloads,
  modelAssetGuidsFromScene,
  type PlayAnimGraphEntry,
  type PlayBehaviourTreeEntry,
  type PlayBlackboardEntry,
} from "../lib/play-content";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";
export type AppRoute = "home" | "editor";

interface DocumentContextValue {
  route: AppRoute;
  projectDocument: ProjectDocument | null;
  projectName: string | null;
  assetRegistry: AssetRegistry | null;
  /** Bumps when encode/import mutates registry payloads in place. */
  registryVersion: number;
  refreshAssetRegistry: () => Promise<void>;
  /** Retarget open tabs after a Scene/Graph file move or rename. */
  repathDocument: (
    kind: AssetDocumentKind,
    oldPath: string,
    newPath: string,
  ) => void;
  retryFailedTextureEncoding: () => Promise<number>;
  retryTextureEncoding: (
    guid: string,
    options?: { maxDimension?: number; force?: boolean },
  ) => Promise<boolean>;
  openDocuments: OpenDocument[];
  tabOrder: string[];
  activeDocumentId: string | null;
  listedProjects: ListedProject[];
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  dirtyDocuments: OpenDocument[];
  migrationPending: MigrationPending[];
  templates: ProjectTemplate[];
  refreshTemplates: () => Promise<void>;
  openProject: () => Promise<void>;
  createEmptyProject: (
    name: string,
    options?: CreateProjectOptions,
  ) => Promise<void>;
  createFromTemplate: (
    templateId: string,
    name: string,
    options?: { pickFolder?: boolean },
  ) => Promise<void>;
  openListedProject: (handle: ProjectFolderHandle) => Promise<void>;
  renameListedProject: (
    handle: ProjectFolderHandle,
    name: string,
  ) => Promise<void>;
  removeListedProject: (handle: ProjectFolderHandle) => Promise<void>;
  reconnectProject: () => Promise<void>;
  saveProject: () => Promise<boolean>;
  saveAll: () => Promise<boolean>;
  approveMigrationsAndSave: () => Promise<void>;
  closeProject: () => Promise<{ blocked: boolean; dirty: OpenDocument[] }>;
  forceCloseProject: () => Promise<void>;
  refreshProjectList: () => Promise<void>;
  exportProject: () => Promise<Uint8Array>;
  dismissRecovery: () => Promise<void>;
  keepRecovery: () => void;
  openDocument: (ref: DocumentRef) => Promise<void>;
  pendingExclusiveScene: DocumentRef | null;
  confirmExclusiveSceneOpen: (mode: "save" | "discard") => Promise<void>;
  cancelExclusiveSceneOpen: () => void;
  closeDocument: (id: string) => void;
  setActiveDocument: (id: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  reorderClosableTabs: (fromIndex: number, toIndex: number) => void;
  updateScene: (id: string, scene: SerializedScene) => void;
  updateGraph: (id: string, graph: SerializedGraph) => void;
  /** Apply a graph edit through the command layer (marks dirty + undoable). */
  applyGraphChange: (id: string, next: SerializedGraph) => Promise<boolean>;
  /** Apply a scene edit through the command layer (marks dirty + undoable). */
  applySceneChange: (id: string, next: SerializedScene) => Promise<boolean>;
  applyAssetDocumentChange: (
    id: string,
    next: Record<string, unknown>,
    mergeKey?: string,
  ) => Promise<boolean>;
  /** Font source / other binary chunks. */
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  /** Write Recast bake bytes onto the Scene asset extra chunk. */
  writeSceneNavmeshChunk: (
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** Persist project.json settings (Input, 2D units, textures, …). */
  updateProjectSettings: (settings: Partial<ProjectDocument["settings"]>) => void;
  undoActiveDocument: () => void;
  redoActiveDocument: () => void;
  canUndoActiveDocument: boolean;
  canRedoActiveDocument: boolean;
  registerDockviewApi: (id: string, api: DockviewApi) => void;
  activateDockPanel: (panelId: string) => void;
  toggleDockWindow: (panelId: string) => void;
  isDockWindowOpen: (panelId: string) => boolean;
  getOpenDockWindowCount: () => number;
  captureActiveLayout: () => void;
  isLayoutFocused: boolean;
  toggleLayoutFocus: () => void;
  getAvailableDocuments: () => Array<{
    kind: "scene" | "graph";
    path: string;
    label: string;
  }>;
  /** Lazy CB thumbnail decode (derived-data LRU, separate from scene cache). */
  loadAssetThumbnail: (assetGuid: string) => Promise<Uint8Array | null>;
  thumbnailsEnabled: boolean;
  /** Compile every project graph into runtime script bundles for Preview. */
  collectScriptBundles: () => Promise<ScriptBundleEntry[]>;
  /** Compile and validate every project graph for the Play prepare path. */
  collectPlayPreviewScripts: () => Promise<{
    bundles: ScriptBundleEntry[];
    diagnostics: Diagnostic[];
  }>;
  collectEditorUtilityScripts: () => Promise<ScriptBundleEntry[]>;
  loadAssetDocument: (
    kind: AssetDocumentKind,
    path: string,
  ) => Promise<unknown | null>;
  /** UserInterface assets keyed by guid for Play apply/remove. */
  collectPlayUiLibrary: () => Promise<Record<string, UserInterfaceDocument>>;
  /** AnimationGraphs referenced by the Play scene (plus any open graph tabs). */
  collectPlayAnimGraphs: (
    scene?: SerializedScene | null,
  ) => Promise<PlayAnimGraphEntry[]>;
  collectPlayBehaviourTrees: (
    scene?: SerializedScene | null,
  ) => Promise<PlayBehaviourTreeEntry[]>;
  collectPlayBlackboards: (
    scene?: SerializedScene | null,
  ) => Promise<PlayBlackboardEntry[]>;
  /** Sprite payloads referenced by the Play scene for clip UV seeks. */
  collectPlaySpritePayloads: (
    scene?: SerializedScene | null,
  ) => Promise<Map<string, SpritePayload>>;
  collectPlayTilemapContent: (
    scene?: SerializedScene | null,
  ) => Promise<{
    tilemaps: Map<string, TilemapPayload>;
    tilesets: Map<string, TilesetPayload>;
  }>;
  /** Texture pixels/source bytes for sprite and tileset `textureGuid`s. */
  collectPlayTextureBytes: (
    sprites: ReadonlyMap<string, SpritePayload>,
    tilesets: ReadonlyMap<string, TilesetPayload>,
  ) => Promise<Map<string, Uint8Array>>;
  /** Model source bytes for scene MeshComponent `assetGuid`s. */
  collectPlayModelBytes: (
    scene?: SerializedScene | null,
  ) => Promise<Map<string, Uint8Array>>;
  /** All project scenes so Play `changescene` can instantiate them. */
  collectPlaySceneLibrary: () => Promise<
    Array<{ guid: string; scene: SerializedScene }>
  >;
  /** Class graph payload from an open tab or disk. */
  loadGraphDocument: (path: string) => Promise<SerializedGraph | null>;
  /** True when a compiled graph changed since the last successful compile (positions ignored). */
  scriptsStale: boolean;
  /** True when Compile should run: never compiled this session, or open graphs changed. */
  graphsNeedCompile: boolean;
  markScriptsCurrent: () => void;
  /** Project-wide search index (headers + Scene/Graph documents). */
  searchIndex: ProjectSearchIndex | null;
}

function openGraphCompileDocuments(
  documentService: DocumentService,
): Array<{ path: string; content: SerializedGraph }> {
  return documentService
    .getOpenDocumentsOrdered()
    .filter((doc) => doc.ref.kind === "graph" && doc.content)
    .map((doc) => ({
      path: doc.ref.path,
      content: doc.content as SerializedGraph,
    }));
}

const DocumentContext = createContext<DocumentContextValue | null>(null);

/** Bumps only the Windows menu so dock add/remove does not remount editor chrome. */
const DockWindowTickContext = createContext(0);

function asDockWindowApi(api: DockviewApi): DockWindowApi {
  return api as unknown as DockWindowApi;
}

function findWindowDefinition(
  kind: string,
  panelId: string,
  actorPrefab = true,
  assets: ReturnType<typeof editorUtilityAssetsFromIndexed> = [],
) {
  if (!isDockviewDocumentKind(kind)) return undefined;
  return findDockOrUtilityWindow(kind, panelId, { actorPrefab, assets });
}

export function DocumentProvider({ children }: { children: ReactNode }) {
  const projectStorage = useMemo(() => createStorage(), []);
  const projectService = useMemo(
    () => new ProjectService(projectStorage),
    [projectStorage],
  );
  const settingsStore = useMemo(() => createAppSettingsStore(), []);
  const derivedStorageRef = useRef<ProjectStorage | null>(null);
  const documentServiceRef = useRef(new DocumentService());
  const editSessionRef = useRef(
    new EditSession({ maxBytes: DEFAULT_EDIT_BYTE_BUDGET }),
  );
  const dockviewApisRef = useRef(new Map<string, DockviewApi>());
  const dockSubscriptionsRef = useRef(new Map<string, Array<{ dispose: () => void }>>());
  const preFocusLayoutsRef = useRef(new Map<string, Record<string, unknown>>());
  const [focusedLayoutIds, setFocusedLayoutIds] = useState<Set<string>>(
    () => new Set(),
  );
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailLruRef = useRef(new ThumbnailDecodeLru(64));
  const thumbnailsEnabledRef = useRef(true);

  const [route, setRoute] = useState<AppRoute>("home");
  const [projectDocument, setProjectDocument] = useState<ProjectDocument | null>(
    null,
  );
  const projectDocumentRef = useRef<ProjectDocument | null>(null);
  projectDocumentRef.current = projectDocument;
  const [listedProjects, setListedProjects] = useState<ListedProject[]>([]);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [migrationPending, setMigrationPending] = useState<MigrationPending[]>(
    [],
  );
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [dockWindowTick, setDockWindowTick] = useState(0);
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState(true);
  const [pendingExclusiveScene, setPendingExclusiveScene] =
    useState<DocumentRef | null>(null);
  const [lastCompiledSignature, setLastCompiledSignature] = useState<
    string | null
  >(null);
  const markScriptsCurrent = useCallback(() => {
    setLastCompiledSignature(
      graphCompileSignature(openGraphCompileDocuments(documentServiceRef.current)),
    );
  }, []);

  const bump = useCallback(() => setRegistryVersion((v) => v + 1), []);
  const bumpDockWindows = useCallback(
    () => setDockWindowTick((v) => v + 1),
    [],
  );
  const documentService = documentServiceRef.current;

  const disposeDockSubscriptions = useCallback((id?: string) => {
    if (id) {
      for (const sub of dockSubscriptionsRef.current.get(id) ?? []) {
        sub.dispose();
      }
      dockSubscriptionsRef.current.delete(id);
      return;
    }
    for (const subs of dockSubscriptionsRef.current.values()) {
      for (const sub of subs) sub.dispose();
    }
    dockSubscriptionsRef.current.clear();
  }, []);

  const ensureDerived = useCallback(async () => {
    if (!derivedStorageRef.current) {
      derivedStorageRef.current = await createDerivedStorage();
    }
    return derivedStorageRef.current;
  }, []);

  const recordRecent = useCallback(
    async (handle: ProjectFolderHandle | null) => {
      if (!handle) return;
      const settings = await settingsStore.load();
      const next = defaultEngineSettings();
      Object.assign(next, settings);
      next.recents = [
        {
          id: handle.id,
          name: handle.name,
          tier: handle.tier,
          lastOpenedAt: new Date().toISOString(),
          bookmark: handle.tier === "external" ? handle.id : null,
        },
        ...settings.recents.filter((r) => r.id !== handle.id),
      ].slice(0, 20);
      await settingsStore.save(next);
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

  const refreshTemplates = useCallback(async () => {
    setTemplates(
      await loadTemplateCards({
        platform: getHostPlatform(),
        loadSettings: () => settingsStore.load(),
        openTemplatesFolder: createTemplateStorage,
      }),
    );
  }, [settingsStore]);

  useEffect(() => {
    documentService.ensureContentBrowserTab();
    void refreshProjectList();
    void refreshTemplates();
    void settingsStore.load().then((settings) => {
      editSessionRef.current.configure({
        maxEntries: settings.undoHistoryLength,
        maxBytes: DEFAULT_EDIT_BYTE_BUDGET,
      });
      thumbnailsEnabledRef.current = settings.thumbnailsEnabled !== false;
      setThumbnailsEnabled(settings.thumbnailsEnabled !== false);
    });
    bump();
  }, [bump, documentService, refreshProjectList, refreshTemplates, settingsStore]);

  useEffect(
    () => projectService.onRegistryChange(bump),
    [bump, projectService],
  );

  const captureLayoutForId = useCallback(
    (id: string) => {
      const preFocus = preFocusLayoutsRef.current.get(id);
      if (preFocus) {
        documentService.setLayout(id, preFocus);
        return;
      }
      const api = dockviewApisRef.current.get(id);
      if (api) {
        documentService.setLayout(id, projectService.captureLayout(api));
      }
    },
    [documentService, projectService],
  );

  const captureAllLayouts = useCallback(() => {
    const { tabOrder } = documentService.getState();
    for (const id of tabOrder) {
      captureLayoutForId(id);
    }
  }, [captureLayoutForId, documentService]);

  const refreshAssetRegistry = useCallback(async () => {
    await projectService.remountRegistry();
    const paths = projectService.registry?.listDocumentPaths();
    if (projectDocument && paths) {
      setProjectDocument({
        ...projectDocument,
        scenes: paths.scenes,
        graphs: paths.graphs,
      });
    }
    bump();
  }, [bump, projectDocument, projectService]);

  const repathDocument = useCallback(
    (kind: AssetDocumentKind, oldPath: string, newPath: string) => {
      documentService.repathDocument(kind, oldPath, newPath);
      bump();
    },
    [bump, documentService],
  );

  const retryFailedTextureEncoding = useCallback(async () => {
    const count = await projectService.retryAllFailedTextureEncoding();
    bump();
    return count;
  }, [bump, projectService]);

  const retryTextureEncoding = useCallback(
    async (
      guid: string,
      options?: { maxDimension?: number; force?: boolean },
    ) => {
      const ok = await projectService.retryTextureEncoding(guid, options);
      bump();
      return ok;
    },
    [bump, projectService],
  );

  const replayRecoveryJournal = useCallback(async () => {
    const guid = projectService.guid;
    if (!guid) return;
    const derived = await ensureDerived();
    const lines = await readJournalLines(derived, guid);
    if (lines.length === 0) {
      setRecoveryAvailable(false);
      return;
    }

    // Ensure every journal target document is open so replay is not skipped.
    for (const raw of lines) {
      try {
        const line = JSON.parse(raw) as { docId?: string };
        const docId = line.docId;
        const kind = docId?.startsWith("graph:")
          ? "graph"
          : docId?.startsWith("scene:")
            ? "scene"
            : null;
        if (!docId || !kind) continue;
        if (documentService.getState().openDocuments.has(docId)) continue;
        const path = docId.slice(`${kind}:`.length);
        await documentService.openDocument(
          projectService,
          { kind, path, label: path.split("/").pop() ?? path },
          null,
          false,
        );
      } catch {
        // Skip malformed lines; replayJournalLines will ignore them too.
      }
    }

    const openDocs = new Map<string, SerializedGraph | SerializedScene>();
    for (const doc of documentService.getOpenDocumentsOrdered()) {
      if ((doc.ref.kind === "graph" || doc.ref.kind === "scene") && doc.content) {
        openDocs.set(doc.id, doc.content as SerializedGraph | SerializedScene);
      }
    }

    const { documents } = replayJournalLines(lines, openDocs);
    for (const [id, content] of documents) {
      if (id.startsWith("scene:")) {
        documentService.updateScene(id, content as SerializedScene);
      } else {
        documentService.updateGraph(id, content as SerializedGraph);
      }
    }
    await truncateJournal(derived, guid);
    setRecoveryAvailable(false);
    bump();
  }, [bump, documentService, ensureDerived, projectService]);

  const enterEditor = useCallback(
    async (
      document: ProjectDocument,
      layouts: Awaited<
        ReturnType<ProjectService["loadCurrentProject"]>
      >["layouts"],
      pending: MigrationPending[] = [],
    ) => {
      dockviewApisRef.current.clear();
      disposeDockSubscriptions();
      preFocusLayoutsRef.current.clear();
      setFocusedLayoutIds(new Set());
      editSessionRef.current.clear();
      await documentService.initializeFromProject(
        projectService,
        document,
        layouts,
      );
      setProjectDocument(document);
      setMigrationPending(pending);
      setLastCompiledSignature(null);
      setRoute("editor");
      const { probeKtx2TranscoderAvailable } = await import(
        "@babylonslate/render"
      );
      const transcoderOk = await probeKtx2TranscoderAvailable();
      await projectService.setTranscoderAvailable(transcoderOk);
      const derived = await ensureDerived();
      projectService.setDerivedStorage(derived);
      const guid = projectService.guid;
      if (guid) {
        setRecoveryAvailable(await hasJournal(derived, guid));
      }
      await recordRecent(projectService.storagePort.getCurrentFolder());
      await refreshProjectList();
      bump();
    },
    [
      bump,
      disposeDockSubscriptions,
      documentService,
      ensureDerived,
      projectService,
      recordRecent,
      refreshProjectList,
    ],
  );

  const openProject = useCallback(async () => {
    const { document, layouts, migrationPending: pending } =
      await projectService.openProject();
    await enterEditor(document, layouts, pending);
  }, [enterEditor, projectService]);

  const createEmptyProject = useCallback(
    async (name: string, options?: CreateProjectOptions) => {
      const { document, layouts, migrationPending: pending } =
        await projectService.createEmptyProject(name, options);
      await enterEditor(document, layouts, pending);
    },
    [enterEditor, projectService],
  );

  const createFromTemplate = useCallback(
    async (
      templateId: string,
      name: string,
      options?: { pickFolder?: boolean },
    ) => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) {
        throw new Error(`Unknown template: ${templateId}`);
      }
      const { document, layouts, migrationPending: pending } =
        await projectService.createFromTemplate({
          templateFiles: template.files,
          name,
          pickFolder: options?.pickFolder,
        });
      await enterEditor(document, layouts, pending);
    },
    [enterEditor, projectService, templates],
  );

  const openListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      const { document, layouts, migrationPending: pending } =
        await projectService.openListedProject(handle);
      await enterEditor(document, layouts, pending);
    },
    [enterEditor, projectService],
  );

  const renameListedProject = useCallback(
    async (handle: ProjectFolderHandle, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        await projectService.renameListedProjectDisplayName(handle, trimmed);
      } catch {
        // Recents still update when the folder cannot be opened.
      }
      const settings = await settingsStore.load();
      settings.recents = settings.recents.map((recent) =>
        recent.id === handle.id ? { ...recent, name: trimmed } : recent,
      );
      await settingsStore.save(settings);
      await refreshProjectList();
    },
    [projectService, refreshProjectList, settingsStore],
  );

  const removeListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      const settings = await settingsStore.load();
      settings.recents = settings.recents.filter(
        (recent) => recent.id !== handle.id,
      );
      await settingsStore.save(settings);
      await refreshProjectList();
    },
    [refreshProjectList, settingsStore],
  );

  const reconnectProject = useCallback(async () => {
    const { document, layouts, migrationPending: pending } =
      await projectService.reconnect();
    await enterEditor(document, layouts, pending);
  }, [enterEditor, projectService]);

  const saveProject = useCallback(async (): Promise<boolean> => {
    const document = projectDocumentRef.current;
    if (!document) return false;
    if (projectService.pendingMigrations.length > 0) {
      setMigrationPending(projectService.pendingMigrations);
      // Caller must use approveMigrationsAndSave — never silently rewrite.
      return false;
    }
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    captureAllLayouts();
    const dirtyDocs = documentService.getDirtyDocuments();
    const savedScene = dirtyDocs.some((doc) => doc.ref.kind === "scene");
    for (const doc of dirtyDocs) {
      if (isAssetDocumentKind(doc.ref.kind) && doc.content) {
        await projectService.saveDocument(
          doc.ref.kind,
          doc.ref.path,
          doc.content as SerializedScene | SerializedGraph | Record<string, unknown>,
        );
      }
    }
    if (document.settings.compileOnSave) {
      const graphs = documentService
        .getOpenDocumentsOrdered()
        .filter((doc) => doc.ref.kind === "graph" && doc.content)
        .map((doc) => ({
          path: doc.ref.path,
          content: doc.content as SerializedGraph,
        }));
      compileGraphDocuments(graphs);
      setLastCompiledSignature(graphCompileSignature(graphs));
    }
    const layouts = documentService.buildLayouts();
    await projectService.saveProject(document, layouts);
    documentService.markAllClean();
    setMigrationPending([]);
    const guid = projectService.guid;
    if (guid) {
      const derived = await ensureDerived();
      await truncateJournal(derived, guid);
      setRecoveryAvailable(false);
    }
    bump();
    if (savedScene) {
      emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.sceneSaved);
    }
    return true;
  }, [bump, captureAllLayouts, documentService, ensureDerived, projectService]);

  const scheduleDebouncedSave = useCallback(() => {
    if (saveDebounceRef.current) return;
    const interval =
      projectDocumentRef.current?.settings.autoSaveIntervalMs ?? 120_000;
    saveDebounceRef.current = setTimeout(() => {
      saveDebounceRef.current = null;
      void saveProject();
    }, interval);
  }, [saveProject]);

  const approveMigrationsAndSave = useCallback(async () => {
    if (!projectDocument) return;
    projectService.approveMigrateOnSave();
    captureAllLayouts();
    const dirtyDocs = documentService.getDirtyDocuments();
    for (const doc of dirtyDocs) {
      if (isAssetDocumentKind(doc.ref.kind) && doc.content) {
        await projectService.saveDocument(
          doc.ref.kind,
          doc.ref.path,
          doc.content as SerializedScene | SerializedGraph | Record<string, unknown>,
        );
      }
    }
    const layouts = documentService.buildLayouts();
    await projectService.saveProject(projectDocument, layouts);
    documentService.markAllClean();
    setMigrationPending([]);
    bump();
  }, [bump, captureAllLayouts, documentService, projectDocument, projectService]);

  const saveAll = saveProject;

  const forceCloseProject = useCallback(async () => {
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    const guid = projectService.guid;
    if (guid) {
      const derived = await ensureDerived();
      await truncateJournal(derived, guid);
    }
    emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.shutdown);
    await projectService.closeProject();
    projectService.setDerivedStorage(null);
    dockviewApisRef.current.clear();
    disposeDockSubscriptions();
    preFocusLayoutsRef.current.clear();
    setFocusedLayoutIds(new Set());
    editSessionRef.current.clear();
    documentService.ensureContentBrowserTab();
    setProjectDocument(null);
    setRecoveryAvailable(false);
    setMigrationPending([]);
    setLastCompiledSignature(null);
    setRoute("home");
    await refreshProjectList();
    bump();
  }, [
    bump,
    disposeDockSubscriptions,
    documentService,
    ensureDerived,
    projectService,
    refreshProjectList,
  ]);

  const closeProject = useCallback(async () => {
    const dirty = documentService.getDirtyDocuments();
    if (dirty.length > 0) {
      return { blocked: true, dirty };
    }
    await forceCloseProject();
    return { blocked: false, dirty: [] };
  }, [documentService, forceCloseProject]);

  const exportProject = useCallback(async () => {
    return projectService.exportZip();
  }, [projectService]);

  const dismissRecovery = useCallback(async () => {
    const guid = projectService.guid;
    if (guid) {
      const derived = await ensureDerived();
      await truncateJournal(derived, guid);
    }
    setRecoveryAvailable(false);
  }, [ensureDerived, projectService]);

  const keepRecovery = useCallback(async () => {
    await replayRecoveryJournal();
  }, [replayRecoveryJournal]);

  const closeDocument = useCallback(
    (id: string) => {
      dockviewApisRef.current.delete(id);
      disposeDockSubscriptions(id);
      preFocusLayoutsRef.current.delete(id);
      setFocusedLayoutIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      documentService.closeDocument(id);
      editSessionRef.current.dropDocument(id);
      bump();
    },
    [bump, disposeDockSubscriptions, documentService],
  );

  const finishOpenDocument = useCallback(
    async (ref: DocumentRef) => {
      const { activeDocumentId } = documentService.getState();
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      if (ref.kind === "scene") {
        const nextId = documentId(ref);
        const others = documentService
          .getOpenDocumentsOrdered()
          .filter((doc) => doc.ref.kind === "scene" && doc.id !== nextId);
        for (const other of others) {
          closeDocument(other.id);
        }
      }
      const layouts = documentService.buildLayouts();
      const layout = layouts.documents[documentId(ref)] ?? null;
      await documentService.openDocument(projectService, ref, layout, true);
      if (ref.kind === "scene") {
        emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.sceneOpen);
      }
      bump();
    },
    [bump, captureLayoutForId, closeDocument, documentService, projectService],
  );

  const openDocument = useCallback(
    async (ref: DocumentRef) => {
      if (ref.kind === "scene") {
        const blocking = dirtyScenesBlockingOpen(
          documentService.getDirtyDocuments(),
          documentId(ref),
        );
        if (blocking.length > 0) {
          setPendingExclusiveScene(ref);
          bump();
          return;
        }
      }
      await finishOpenDocument(ref);
    },
    [bump, documentService, finishOpenDocument],
  );

  const confirmExclusiveSceneOpen = useCallback(
    async (mode: "save" | "discard") => {
      const ref = pendingExclusiveScene;
      if (!ref) return;
      if (mode === "save") {
        const saved = await saveAll();
        if (!saved) return;
      }
      setPendingExclusiveScene(null);
      await finishOpenDocument(ref);
    },
    [finishOpenDocument, pendingExclusiveScene, saveAll],
  );

  const cancelExclusiveSceneOpen = useCallback(() => {
    setPendingExclusiveScene(null);
  }, []);

  const setActiveDocument = useCallback(
    (id: string) => {
      const { activeDocumentId } = documentService.getState();
      if (id === activeDocumentId) return;
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      documentService.setActiveDocument(id);
      bump();
    },
    [bump, captureLayoutForId, documentService],
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

  const updateScene = useCallback(
    (id: string, scene: SerializedScene) => {
      documentService.updateScene(id, scene);
      bump();
    },
    [bump, documentService],
  );

  const updateGraph = useCallback(
    (id: string, graph: SerializedGraph) => {
      documentService.updateGraph(id, graph);
      bump();
    },
    [bump, documentService],
  );

  const updateProjectSettings = useCallback(
    (settings: Partial<ProjectDocument["settings"]>) => {
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
            input: settings.input
              ? settings.input
              : current.settings.input,
          }),
          metadata: {
            ...current.metadata,
            updatedAt: new Date().toISOString(),
          },
        };
      });
      scheduleDebouncedSave();
      bump();
    },
    [bump, scheduleDebouncedSave],
  );

  const applyGraphChange = useCallback(
    async (id: string, next: SerializedGraph): Promise<boolean> => {
      const doc = documentService.getState().openDocuments.get(id);
      if (!doc || doc.ref.kind !== "graph" || !doc.content) {
        return false;
      }
      const previous = doc.content as SerializedGraph;
      const commands = diffGraphCommands(previous, next);
      if (commands.length === 0) {
        return false;
      }
      let current = previous;
      for (const command of commands) {
        current = editSessionRef.current.apply(id, current, command).doc;
      }
      documentService.updateGraph(id, current);
      projectService.indexOpenDocument(doc.ref.path, current);
      await notifyDocumentEdited({
        scheduleDebouncedSave,
        bump,
        journal: async () => {
          const guid = projectService.guid;
          if (!guid) return;
          const derived = await ensureDerived();
          for (const command of commands) {
            await appendJournalLine(
              derived,
              guid,
              serializeJournalLine({
                v: 1,
                docId: id,
                at: new Date().toISOString(),
                command: commandToJournalPayload(command),
              }),
            );
          }
        },
      });
      return true;
    },
    [bump, documentService, ensureDerived, projectService, scheduleDebouncedSave],
  );

  const applySceneChange = useCallback(
    async (id: string, next: SerializedScene): Promise<boolean> => {
      const doc = documentService.getState().openDocuments.get(id);
      if (!doc || doc.ref.kind !== "scene" || !doc.content) {
        return false;
      }
      const previous = doc.content as SerializedScene;
      const commands = diffSceneCommands(previous, next);
      if (commands.length === 0) {
        return false;
      }
      let current = previous;
      for (const command of commands) {
        current = editSessionRef.current.apply(id, current, command).doc;
      }
      documentService.updateScene(id, current);
      projectService.indexOpenDocument(doc.ref.path, current);
      await notifyDocumentEdited({
        scheduleDebouncedSave,
        bump,
        journal: async () => {
          const guid = projectService.guid;
          if (!guid) return;
          const derived = await ensureDerived();
          for (const command of commands) {
            await appendJournalLine(
              derived,
              guid,
              serializeJournalLine({
                v: 1,
                docId: id,
                at: new Date().toISOString(),
                command: commandToJournalPayload(command),
              }),
            );
          }
        },
      });
      return true;
    },
    [bump, documentService, ensureDerived, projectService, scheduleDebouncedSave],
  );

  const applyAssetDocumentChange = useCallback(
    async (
      id: string,
      next: Record<string, unknown>,
      mergeKey?: string,
    ): Promise<boolean> => {
      const doc = documentService.getState().openDocuments.get(id);
      if (
        !doc ||
        !isAssetDocumentKind(doc.ref.kind) ||
        doc.ref.kind === "scene" ||
        doc.ref.kind === "graph" ||
        !doc.content
      ) {
        return false;
      }
      const previous = doc.content as Record<string, unknown>;
      const command = new SetAssetDocumentCommand(previous, next, mergeKey);
      const current = editSessionRef.current.apply(id, previous, command).doc;
      documentService.updateAssetDocument(id, current);
      projectService.indexOpenDocument(doc.ref.path, current);
      await notifyDocumentEdited({
        scheduleDebouncedSave,
        bump,
        journal: async () => {
          const guid = projectService.guid;
          if (!guid) return;
          const derived = await ensureDerived();
          await appendJournalLine(
            derived,
            guid,
            serializeJournalLine({
              v: 1,
              docId: id,
              at: new Date().toISOString(),
              command: commandToJournalPayload(command),
            }),
          );
        },
      });
      return true;
    },
    [bump, documentService, ensureDerived, projectService, scheduleDebouncedSave],
  );

  const readAssetChunk = useCallback(
    (path: string, chunkId: string) =>
      projectService.readAssetChunk(path, chunkId),
    [projectService],
  );

  const writeSceneNavmeshChunk = useCallback(
    (path: string, bytes: Uint8Array, payload: Record<string, unknown>) =>
      projectService.writeSceneNavmeshChunk(path, bytes, payload),
    [projectService],
  );

  const loadClassGraphDocuments = useCallback(async (): Promise<
    Array<{ path: string; content: SerializedGraph }>
  > => {
    const paths = projectDocument?.graphs ?? [];
    const open = documentService.getState().openDocuments;
    const documents: Array<{ path: string; content: SerializedGraph }> = [];
    for (const path of paths) {
      const openDoc = open.get(documentId({ kind: "graph", path }));
      if (openDoc?.content) {
        documents.push({ path, content: openDoc.content as SerializedGraph });
        continue;
      }
      try {
        const content = (await projectService.loadDocument(
          "graph",
          path,
        )) as SerializedGraph;
        documents.push({ path, content });
      } catch (error) {
        console.error(`[play] failed to load graph ${path}`, error);
      }
    }
    return documents;
  }, [documentService, projectDocument, projectService]);

  const loadProjectGraphDocuments = useCallback(async (): Promise<
    Array<{ path: string; content: SerializedGraph }>
  > => {
    const documents = await loadClassGraphDocuments();
    const open = documentService.getState().openDocuments;
    const uiAssets = (projectService.registry?.list() ?? []).filter(
      (asset) => asset.header.type === "UserInterface",
    );
    const uiPayloads: Array<{ path: string; payload: unknown }> = [];
    for (const asset of uiAssets) {
      const openDoc = open.get(documentId({ kind: "ui", path: asset.path }));
      if (openDoc?.content) {
        uiPayloads.push({ path: asset.path, payload: openDoc.content });
        continue;
      }
      try {
        uiPayloads.push({
          path: asset.path,
          payload: await projectService.loadDocument("ui", asset.path),
        });
      } catch (error) {
        console.error(`[play] failed to load UserInterface logic ${asset.path}`, error);
      }
    }
    const assets = projectService.registry?.list() ?? [];
    const headers = Object.fromEntries(
      assets.map((asset) => [
        asset.path,
        {
          type: asset.header.type,
          parentClass: asset.header.parentClass ?? null,
          name: asset.header.name,
        },
      ]),
    );
    const parentOf = classParentLookup(assets);
    return collectPlayScriptDocuments(documents, uiPayloads, headers, parentOf);
  }, [documentService, loadClassGraphDocuments, projectService]);

  const collectEditorUtilityScripts = useCallback(async (): Promise<
    ScriptBundleEntry[]
  > => {
    const documents = await loadClassGraphDocuments();
    const assets = projectService.registry?.list() ?? [];
    const headers = Object.fromEntries(
      assets.map((asset) => [
        asset.path,
        {
          type: asset.header.type,
          parentClass: asset.header.parentClass ?? null,
          name: asset.header.name,
        },
      ]),
    );
    const parentOf = classParentLookup(assets);
    const registered =
      projectDocumentRef.current?.settings.editorUtilityObjects ?? [];
    const selected = selectEditorUtilityGraphs(documents, {
      headers,
      parentOf,
      registeredClassIds: registered,
    });
    return compileGraphDocuments(selected);
  }, [loadClassGraphDocuments, projectService]);

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
        return await projectService.loadDocument(kind, path);
      } catch (error) {
        console.error(`[editor] failed to load ${kind} ${path}`, error);
        return null;
      }
    },
    [documentService, projectService],
  );

  const collectScriptBundles = useCallback(async (): Promise<
    ScriptBundleEntry[]
  > => {
    const documents = await loadProjectGraphDocuments();
    const bundles = compileGraphDocuments(documents);
    markScriptsCurrent();
    return bundles;
  }, [loadProjectGraphDocuments, markScriptsCurrent]);

  const collectPlayPreviewScripts = useCallback(async (): Promise<{
    bundles: ScriptBundleEntry[];
    diagnostics: Diagnostic[];
  }> => {
    const documents = await loadProjectGraphDocuments();
    const diagnostics = documents.flatMap((doc) =>
      validateSerializedGraph(doc.content, {
        assetGuid: doc.path,
        graphId: documentId({ kind: "graph", path: doc.path }),
      }),
    );
    const bundles = compileGraphDocuments(documents);
    markScriptsCurrent();
    return { bundles, diagnostics };
  }, [loadProjectGraphDocuments, markScriptsCurrent]);

  const collectPlayUiLibrary = useCallback(async (): Promise<
    Record<string, UserInterfaceDocument>
  > => {
    const assets = (projectService.registry?.list() ?? []).map((asset) => ({
      guid: asset.header.guid,
      path: asset.path,
      type: asset.header.type,
    }));
    const open = documentService.getState().openDocuments;
    const loaded = new Map<string, unknown>();
    for (const asset of assets) {
      if (asset.type !== "UserInterface") continue;
      const openDoc = open.get(documentId({ kind: "ui", path: asset.path }));
      if (openDoc?.content) {
        loaded.set(asset.path, openDoc.content);
        continue;
      }
      try {
        loaded.set(
          asset.path,
          await projectService.loadDocument("ui", asset.path),
        );
      } catch (error) {
        console.error(`[play] failed to load UserInterface ${asset.path}`, error);
      }
    }
    return playUiLibraryFromAssets(assets, (path) => loaded.get(path) ?? null);
  }, [documentService, projectService]);

  const loadPlayAssetContent = useCallback(
    async (
      kind:
        | "anim-graph"
        | "behaviour-tree"
        | "blackboard"
        | "sprite"
        | "ui"
        | "tileset"
        | "tilemap",
      path: string,
    ): Promise<unknown | null> => {
      const openDoc = documentService
        .getState()
        .openDocuments.get(documentId({ kind, path }));
      if (openDoc?.content) return openDoc.content;
      try {
        return await projectService.loadDocument(kind, path);
      } catch (error) {
        console.error(`[play] failed to load ${kind} ${path}`, error);
        return null;
      }
    },
    [documentService, projectService],
  );

  const collectPlayAnimGraphs = useCallback(
    async (scene?: SerializedScene | null): Promise<PlayAnimGraphEntry[]> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "AnimationGraph")
          .map((asset) => [asset.header.guid, asset]),
      );
      const openEntries = playAnimGraphsFromOpenDocuments(
        [...documentService.getState().openDocuments.values()],
        (path) =>
          assets.find((asset) => asset.path === path)?.header.guid ?? null,
      );
      const needed = new Set([
        ...animationGraphGuidsFromScene(scene),
        ...openEntries.map((entry) => entry.guid),
      ]);
      const loaded = new Map<string, unknown>();
      for (const guid of needed) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent("anim-graph", asset.path);
        if (content) loaded.set(guid, content);
      }
      return mergePlayAnimGraphs(
        openEntries,
        playAnimGraphsFromGuids([...needed], (guid) => loaded.get(guid) ?? null),
      );
    },
    [documentService, loadPlayAssetContent, projectService],
  );

  const collectPlayBehaviourTrees = useCallback(
    async (scene?: SerializedScene | null): Promise<PlayBehaviourTreeEntry[]> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "BehaviourTree")
          .map((asset) => [asset.header.guid, asset]),
      );
      const openEntries = playBehaviourTreesFromOpenDocuments(
        [...documentService.getState().openDocuments.values()],
        (path) =>
          assets.find((asset) => asset.path === path)?.header.guid ?? null,
      );
      const needed = new Set([
        ...behaviourTreeGuidsFromScene(scene),
        ...openEntries.map((entry) => entry.guid),
      ]);
      const loaded = new Map<string, unknown>();
      for (const guid of needed) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent("behaviour-tree", asset.path);
        if (content) loaded.set(guid, content);
      }
      return mergePlayBehaviourTrees(
        openEntries,
        playBehaviourTreesFromGuids([...needed], (guid) => loaded.get(guid) ?? null),
      );
    },
    [documentService, loadPlayAssetContent, projectService],
  );

  const collectPlayBlackboards = useCallback(
    async (scene?: SerializedScene | null): Promise<PlayBlackboardEntry[]> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "Blackboard")
          .map((asset) => [asset.header.guid, asset]),
      );
      const openEntries = playBlackboardsFromOpenDocuments(
        [...documentService.getState().openDocuments.values()],
        (path) =>
          assets.find((asset) => asset.path === path)?.header.guid ?? null,
      );
      const needed = new Set([
        ...blackboardGuidsFromScene(scene),
        ...openEntries.map((entry) => entry.guid),
      ]);
      const loaded = new Map<string, unknown>();
      for (const guid of needed) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent("blackboard", asset.path);
        if (content) loaded.set(guid, content);
      }
      return mergePlayBlackboards(
        openEntries,
        playBlackboardsFromGuids([...needed], (guid) => loaded.get(guid) ?? null),
      );
    },
    [documentService, loadPlayAssetContent, projectService],
  );

  const collectPlaySpritePayloads = useCallback(
    async (
      scene?: SerializedScene | null,
    ): Promise<Map<string, SpritePayload>> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "Sprite")
          .map((asset) => [asset.header.guid, asset]),
      );
      const loaded = new Map<string, unknown>();
      for (const guid of spriteAssetGuidsFromScene(scene)) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent("sprite", asset.path);
        if (content) loaded.set(guid, content);
      }
      return playSpritePayloadsFromGuids(
        [...loaded.keys()],
        (guid) => loaded.get(guid) ?? null,
      );
    },
    [loadPlayAssetContent, projectService],
  );

  const collectPlayTilemapContent = useCallback(
    async (
      scene?: SerializedScene | null,
    ): Promise<{
      tilemaps: Map<string, TilemapPayload>;
      tilesets: Map<string, TilesetPayload>;
    }> => {
      const assets = projectService.registry?.list() ?? [];
      const tilemapsByGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "Tilemap")
          .map((asset) => [asset.header.guid, asset]),
      );
      const tilesetsByGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "Tileset")
          .map((asset) => [asset.header.guid, asset]),
      );
      const loadedMaps = new Map<string, unknown>();
      for (const guid of tilemapAssetGuidsFromScene(scene)) {
        const asset = tilemapsByGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent("tilemap", asset.path);
        if (content) loadedMaps.set(guid, content);
      }
      const tilemaps = playTilemapPayloadsFromGuids(
        [...loadedMaps.keys()],
        (guid) => loadedMaps.get(guid) ?? null,
      );
      const loadedSets = new Map<string, unknown>();
      for (const guid of tilesetGuidsFromTilemaps(tilemaps)) {
        const asset = tilesetsByGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent("tileset", asset.path);
        if (content) loadedSets.set(guid, content);
      }
      return {
        tilemaps,
        tilesets: playTilesetPayloadsFromGuids(
          [...loadedSets.keys()],
          (guid) => loadedSets.get(guid) ?? null,
        ),
      };
    },
    [loadPlayAssetContent, projectService],
  );

  const collectPlayTextureBytes = useCallback(
    async (
      sprites: ReadonlyMap<string, SpritePayload>,
      tilesets: ReadonlyMap<string, TilesetPayload>,
    ): Promise<Map<string, Uint8Array>> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets.map((asset) => [asset.header.guid, asset] as const),
      );
      const bytes = new Map<string, Uint8Array>();
      for (const guid of textureGuidsFromPlayPayloads(sprites, tilesets)) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const pixels = await projectService.readAssetChunk(asset.path, "pixels");
        if (pixels && pixels.byteLength > 0) {
          bytes.set(guid, pixels);
          continue;
        }
        const source = await projectService.readAssetChunk(asset.path, "source");
        if (source && source.byteLength > 0) bytes.set(guid, source);
      }
      return bytes;
    },
    [projectService],
  );

  const collectPlayModelBytes = useCallback(
    async (scene?: SerializedScene | null): Promise<Map<string, Uint8Array>> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets.map((asset) => [asset.header.guid, asset] as const),
      );
      const bytes = new Map<string, Uint8Array>();
      for (const guid of modelAssetGuidsFromScene(scene)) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const source = await projectService.readAssetChunk(asset.path, "source");
        if (source && source.byteLength > 0) bytes.set(guid, source);
      }
      return bytes;
    },
    [projectService],
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

  const collectPlaySceneLibrary = useCallback(async (): Promise<
    Array<{ guid: string; scene: SerializedScene }>
  > => {
    const paths = projectDocument?.scenes ?? [];
    const open = documentService.getState().openDocuments;
    const scenes: Array<{ guid: string; scene: SerializedScene }> = [];
    for (const path of paths) {
      const id = documentId({ kind: "scene", path });
      const openDoc = open.get(id);
      try {
        const content =
          openDoc?.content ?? (await projectService.loadDocument("scene", path));
        scenes.push({ guid: id, scene: normalizeScene(content) });
      } catch (error) {
        console.error(`[play] failed to load scene ${path}`, error);
      }
    }
    return scenes;
  }, [documentService, projectDocument, projectService]);

  const loadAssetThumbnail = useCallback(
    async (assetGuid: string): Promise<Uint8Array | null> => {
      if (!thumbnailsEnabledRef.current) return null;
      const cached = thumbnailLruRef.current.get(assetGuid);
      if (cached) return cached;
      const guid = projectService.guid;
      if (!guid) return null;
      const derived = await ensureDerived();
      const bytes = await readThumbnail(derived, guid, assetGuid);
      if (bytes) thumbnailLruRef.current.set(assetGuid, bytes);
      return bytes;
    },
    [ensureDerived, projectService],
  );

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    const host = globalThis as {
      __babylonslateTest?: {
        ensureMainGraphOpen: () => Promise<boolean>;
        nudgeActiveGraphNode: () => Promise<boolean>;
        cancelDebouncedSave: () => void;
        activeGraphNodePosition: () => { x: number; y: number } | null;
        hasRecoveryJournal: () => Promise<boolean>;
        /** Move the first scene actor by a fixed delta through the command layer. */
        nudgeActiveSceneActor: () => Promise<boolean>;
        activeSceneActorPosition: () => [number, number, number] | null;
        injectTestGamepad: (pad: {
          index?: number;
          axes?: number[];
          buttons?: number[];
        } | null) => void;
        injectTestTouchAxis: (axes: Record<string, number> | null) => void;
        setMainGraphContent: (graph: SerializedGraph) => Promise<boolean>;
        guidForPath: (path: string) => string | null;
        activeTilemapTile: (gx: number, gy: number) => number | null;
      };
    };
    host.__babylonslateTest = {
      cancelDebouncedSave: () => {
        if (saveDebounceRef.current) {
          clearTimeout(saveDebounceRef.current);
          saveDebounceRef.current = null;
        }
      },
      activeGraphNodePosition: () => {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "graph" && entry.content,
        );
        const graph = doc?.content as SerializedGraph | undefined;
        return graph?.nodes[0]?.position
          ? { ...graph.nodes[0].position }
          : null;
      },
      hasRecoveryJournal: async () => {
        const guid = projectService.guid;
        if (!guid) return false;
        const derived = await ensureDerived();
        return hasJournal(derived, guid);
      },
      /** Open main graph without activating it (avoids GraphEditor stomping edits). */
      ensureMainGraphOpen: async () => {
        const candidates = [
          "assets/main.class.babasset",
          "assets/main.graph.babasset",
        ];
        const existing = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "graph",
        );
        if (existing) return true;
        const registry = projectService.registry;
        const path =
          candidates.find((candidate) =>
            registry?.list().some((asset) => asset.path === candidate),
          ) ?? candidates[0]!;
        const id = `graph:${path}`;
        if (!documentService.getState().openDocuments.has(id)) {
          await documentService.openDocument(
            projectService,
            { kind: "graph", path, label: path.split("/").pop() ?? path },
            null,
            false,
          );
          bump();
        }
        return documentService.getState().openDocuments.has(id);
      },
      nudgeActiveGraphNode: async () => {
        const openDocuments = documentService.getState().openDocuments;
        const id = [...openDocuments.values()].find((d) => d.ref.kind === "graph")
          ?.id;
        if (!id) return false;
        const doc = openDocuments.get(id);
        if (!doc?.content) return false;
        const graph = structuredClone(doc.content as SerializedGraph);
        if (!graph.nodes[0]) return false;
        graph.nodes[0] = {
          ...graph.nodes[0],
          position: {
            x: graph.nodes[0].position.x + 42,
            y: graph.nodes[0].position.y + 17,
          },
        };
        return applyGraphChange(id, graph);
      },
      activeSceneActorPosition: () => {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "scene" && entry.content,
        );
        const scene = doc?.content as SerializedScene | undefined;
        const position = scene?.actors[0]?.transform.position;
        return position ? [...position] : null;
      },
      nudgeActiveSceneActor: async () => {
        const openDocuments = documentService.getState().openDocuments;
        const id = [...openDocuments.values()].find((d) => d.ref.kind === "scene")
          ?.id;
        if (!id) return false;
        const doc = openDocuments.get(id);
        if (!doc?.content) return false;
        const scene = structuredClone(doc.content as SerializedScene);
        const actor = scene.actors[0];
        if (!actor) return false;
        const [x, y, z] = actor.transform.position;
        scene.actors[0] = {
          ...actor,
          transform: {
            ...actor.transform,
            position: [x + 1.5, y, z],
          },
        };
        return applySceneChange(id, scene);
      },
      injectTestGamepad: (pad) => {
        const globalHost = globalThis as {
          __babylonslateTestGamepad?: {
            index: number;
            axes: number[];
            buttons: number[];
          };
        };
        if (!pad) {
          delete globalHost.__babylonslateTestGamepad;
          return;
        }
        globalHost.__babylonslateTestGamepad = {
          index: pad.index ?? 0,
          axes: pad.axes ?? [0, 0, 0, 0],
          buttons: pad.buttons ?? [0, 0, 0, 0],
        };
      },
      injectTestTouchAxis: (axes) => {
        const globalHost = globalThis as {
          __babylonslateTestTouchAxes?: Record<string, number>;
        };
        if (!axes) {
          delete globalHost.__babylonslateTestTouchAxes;
          return;
        }
        globalHost.__babylonslateTestTouchAxes = { ...axes };
      },
      /** Replace the main graph so Preview compiles a known script. */
      setMainGraphContent: async (graph: SerializedGraph) => {
        const candidates = [
          "assets/main.class.babasset",
          "assets/main.graph.babasset",
        ];
        const openGraph = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "graph",
        );
        const path =
          openGraph?.ref.path ??
          candidates.find((candidate) =>
            projectService.registry
              ?.list()
              .some((asset) => asset.path === candidate),
          ) ??
          candidates[0]!;
        const id = `graph:${path}`;
        if (!documentService.getState().openDocuments.has(id)) {
          await documentService.openDocument(
            projectService,
            { kind: "graph", path, label: path.split("/").pop() ?? path },
            null,
            false,
          );
        }
        documentService.updateGraph(id, graph);
        bump();
        return true;
      },
      guidForPath: (path: string) => projectService.guidForPath(path),
      activeTilemapTile: (gx: number, gy: number) => {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "tilemap" && entry.content,
        );
        if (!doc?.content) return null;
        const map = normalizeTilemapPayload(doc.content);
        const layerId = map.layers[0]?.id;
        if (!layerId) return null;
        return getTile(map, layerId, gx, gy);
      },
    };
    return () => {
      delete host.__babylonslateTest;
      delete (globalThis as { __babylonslateTestGamepad?: unknown })
        .__babylonslateTestGamepad;
      delete (globalThis as { __babylonslateTestTouchAxes?: unknown })
        .__babylonslateTestTouchAxes;
    };
  }, [
    applyGraphChange,
    applySceneChange,
    applyAssetDocumentChange,
    bump,
    documentService,
    ensureDerived,
    projectService,
  ]);

  const stepActiveDocumentHistory = useCallback(
    (direction: "undo" | "redo") => {
      const { activeDocumentId, openDocuments } = documentService.getState();
      if (!activeDocumentId) return;
      const doc = openDocuments.get(activeDocumentId);
      if (!doc?.content) return;
      if (doc.ref.kind === "graph") {
        const stack =
          editSessionRef.current.getStack<SerializedGraph>(activeDocumentId);
        const content = doc.content as SerializedGraph;
        const result =
          direction === "undo" ? stack.undo(content) : stack.redo(content);
        if (!result) return;
        documentService.updateGraph(activeDocumentId, result.doc);
        bump();
        return;
      }
      if (doc.ref.kind === "scene") {
        const stack =
          editSessionRef.current.getStack<SerializedScene>(activeDocumentId);
        const content = doc.content as SerializedScene;
        const result =
          direction === "undo" ? stack.undo(content) : stack.redo(content);
        if (!result) return;
        documentService.updateScene(activeDocumentId, result.doc);
        bump();
        return;
      }
      if (isAssetDocumentKind(doc.ref.kind)) {
        const stack = editSessionRef.current.getStack<Record<string, unknown>>(
          activeDocumentId,
        );
        const content = doc.content as Record<string, unknown>;
        const result =
          direction === "undo" ? stack.undo(content) : stack.redo(content);
        if (!result) return;
        documentService.updateAssetDocument(activeDocumentId, result.doc);
        bump();
      }
    },
    [bump, documentService],
  );

  const undoActiveDocument = useCallback(() => {
    stepActiveDocumentHistory("undo");
  }, [stepActiveDocumentHistory]);

  const redoActiveDocument = useCallback(() => {
    stepActiveDocumentHistory("redo");
  }, [stepActiveDocumentHistory]);

  const registerDockviewApi = useCallback((id: string, api: DockviewApi) => {
    dockviewApisRef.current.set(id, api);
    disposeDockSubscriptions(id);
    const rememberPlacements = () => {
      if (preFocusLayoutsRef.current.has(id)) return;
      const dock = asDockWindowApi(api);
      const kind = documentService.getDocument(id)?.ref.kind;
      for (const panel of listDockPanels(dock)) {
        const def = isDockviewDocumentKind(kind)
          ? findWindowDefinition(
              kind,
              panel.id,
              true,
              editorUtilityAssetsFromIndexed(
                projectService.registry?.list() ?? [],
              ),
            )
          : undefined;
        const placement = capturePanelPlacement(dock, panel.id, def);
        if (placement) {
          documentService.setPanelPlacement(id, panel.id, placement);
        }
      }
    };
    dockSubscriptionsRef.current.set(id, [
      api.onDidAddPanel(() => bumpDockWindows()),
      api.onDidRemovePanel(() => bumpDockWindows()),
      api.onDidLayoutChange(rememberPlacements),
    ]);
    rememberPlacements();
    bumpDockWindows();
  }, [bumpDockWindows, disposeDockSubscriptions, documentService, projectService]);

  const activateDockPanel = useCallback((panelId: string) => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    dockviewApisRef.current.get(activeDocumentId)?.getPanel(panelId)?.api.setActive();
  }, [documentService]);

  const toggleDockWindow = useCallback((panelId: string) => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = documentService.getDocument(activeDocumentId);
    if (!doc || !isDockviewDocumentKind(doc.ref.kind)) {
      return;
    }
    const api = dockviewApisRef.current.get(activeDocumentId);
    if (!api) return;
    const indexed = projectService.registry
      ?.list()
      .find((asset) => asset.path === doc.ref.path);
    const parentOf = classParentLookup(projectService.registry?.list() ?? []);
    const actorPrefab =
      doc.ref.kind !== "graph" ||
      !indexed ||
      classDocumentShowsPrefab(indexed.header.parentClass, parentOf, {
        assetType: indexed.header.type,
      });
    const def = findWindowDefinition(
      doc.ref.kind,
      panelId,
      actorPrefab,
      editorUtilityAssetsFromIndexed(projectService.registry?.list() ?? []),
    );
    if (!def) return;
    const remembered =
      documentService.getPanelPlacements(activeDocumentId)[panelId] ?? null;
    const result = toggleDockWindowOnApi(
      asDockWindowApi(api),
      def,
      remembered,
    );
    if (result.placement) {
      documentService.setPanelPlacement(
        activeDocumentId,
        panelId,
        result.placement,
      );
    }
    bumpDockWindows();
  }, [bumpDockWindows, documentService, projectService]);

  const isDockWindowOpen = useCallback((panelId: string) => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return false;
    const api = dockviewApisRef.current.get(activeDocumentId);
    return api ? isDockWindowOpenOnApi(asDockWindowApi(api), panelId) : false;
  }, [documentService]);

  const getOpenDockWindowCount = useCallback(() => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return 0;
    const api = dockviewApisRef.current.get(activeDocumentId);
    return api ? listDockPanels(asDockWindowApi(api)).length : 0;
  }, [documentService]);

  const toggleLayoutFocus = useCallback(async () => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = documentService
      .getOpenDocumentsOrdered()
      .find((entry) => entry.id === activeDocumentId);
    if (!doc || !isDockviewDocumentKind(doc.ref.kind)) {
      return;
    }
    const api = dockviewApisRef.current.get(activeDocumentId);
    if (!api) return;

    if (preFocusLayoutsRef.current.has(activeDocumentId)) {
      const snapshot = preFocusLayoutsRef.current.get(activeDocumentId);
      preFocusLayoutsRef.current.delete(activeDocumentId);
      if (snapshot) {
        api.fromJSON(snapshot as never);
      }
      setFocusedLayoutIds((current) => {
        const next = new Set(current);
        next.delete(activeDocumentId);
        return next;
      });
      return;
    }

    const settings = await settingsStore.load();
    if (preFocusLayoutsRef.current.has(activeDocumentId)) {
      return;
    }
    const dock = dockviewApisRef.current.get(activeDocumentId);
    if (!dock) return;

    preFocusLayoutsRef.current.set(
      activeDocumentId,
      dock.toJSON() as unknown as Record<string, unknown>,
    );
    applyFocusLayout(
      doc.ref.kind,
      dock,
      doc.ref.kind === "scene" || doc.ref.kind === "graph"
        ? settings.focusKeepPanels[doc.ref.kind]
        : undefined,
    );
    setFocusedLayoutIds((current) => {
      const next = new Set(current);
      next.add(activeDocumentId);
      return next;
    });
  }, [documentService, settingsStore]);

  const captureActiveLayout = useCallback(() => {
    const { activeDocumentId } = documentService.getState();
    if (activeDocumentId) {
      captureLayoutForId(activeDocumentId);
    }
  }, [captureLayoutForId, documentService]);

  const getAvailableDocuments = useCallback(() => {
    if (!projectDocument) return [];
    const { tabOrder } = documentService.getState();
    const openIds = new Set(tabOrder);
    const available: Array<{
      kind: "scene" | "graph";
      path: string;
      label: string;
    }> = [];

    for (const path of projectDocument.scenes) {
      const id = documentId({ kind: "scene", path });
      if (!openIds.has(id)) {
        available.push({
          kind: "scene",
          path,
          label: path.split("/").pop() ?? path,
        });
      }
    }
    for (const path of projectDocument.graphs) {
      const id = documentId({ kind: "graph", path });
      if (!openIds.has(id)) {
        available.push({
          kind: "graph",
          path,
          label: path.split("/").pop() ?? path,
        });
      }
    }
    return available;
  }, [documentService, projectDocument]);

  const value = useMemo<DocumentContextValue>(
    () => {
      const currentGraphSignature = graphCompileSignature(
        openGraphCompileDocuments(documentService),
      );
      return {
      route,
      projectDocument,
      projectName: projectDocument?.metadata.name ?? null,
      openDocuments: documentService.getOpenDocumentsOrdered(),
      tabOrder: [...documentService.getState().tabOrder],
      activeDocumentId: documentService.getState().activeDocumentId,
      listedProjects,
      needsReconnect,
      recoveryAvailable,
      dirtyDocuments: documentService.getDirtyDocuments(),
      migrationPending,
      templates,
      refreshTemplates,
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      renameListedProject,
      removeListedProject,
      reconnectProject,
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      closeProject,
      forceCloseProject,
      refreshProjectList,
      exportProject,
      dismissRecovery,
      keepRecovery,
      openDocument,
      pendingExclusiveScene,
      confirmExclusiveSceneOpen,
      cancelExclusiveSceneOpen,
      closeDocument,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
      updateScene,
      updateGraph,
      applyGraphChange,
      applySceneChange,
      applyAssetDocumentChange,
      readAssetChunk,
      writeSceneNavmeshChunk,
      updateProjectSettings,
      undoActiveDocument,
      redoActiveDocument,
      canUndoActiveDocument: (() => {
        const activeId = documentService.getState().activeDocumentId;
        return activeId
          ? editSessionRef.current.getStack(activeId).canUndo
          : false;
      })(),
      canRedoActiveDocument: (() => {
        const activeId = documentService.getState().activeDocumentId;
        return activeId
          ? editSessionRef.current.getStack(activeId).canRedo
          : false;
      })(),
      registerDockviewApi,
      activateDockPanel,
      toggleDockWindow,
      isDockWindowOpen,
      getOpenDockWindowCount,
      captureActiveLayout,
      isLayoutFocused: (() => {
        const activeId = documentService.getState().activeDocumentId;
        return activeId ? focusedLayoutIds.has(activeId) : false;
      })(),
      toggleLayoutFocus,
      getAvailableDocuments,
      assetRegistry: projectService.registry,
      registryVersion,
      refreshAssetRegistry,
      repathDocument,
      retryFailedTextureEncoding,
      retryTextureEncoding,
      loadAssetThumbnail,
      thumbnailsEnabled,
      collectScriptBundles,
      collectPlayPreviewScripts,
      collectEditorUtilityScripts,
      loadAssetDocument,
      collectPlayUiLibrary,
      collectPlayAnimGraphs,
      collectPlayBehaviourTrees,
      collectPlayBlackboards,
      collectPlaySpritePayloads,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayModelBytes,
      collectPlaySceneLibrary,
      loadGraphDocument,
      graphsNeedCompile: compileSignatureIsStale(
        currentGraphSignature,
        lastCompiledSignature,
      ),
      scriptsStale:
        lastCompiledSignature !== null &&
        compileSignatureIsStale(currentGraphSignature, lastCompiledSignature),
      markScriptsCurrent,
      searchIndex: projectService.searchIndex,
    };
    },
    [
      registryVersion,
      route,
      projectDocument,
      documentService,
      projectService,
      refreshAssetRegistry,
      repathDocument,
      retryFailedTextureEncoding,
      retryTextureEncoding,
      loadAssetThumbnail,
      thumbnailsEnabled,
      collectScriptBundles,
      collectPlayPreviewScripts,
      collectEditorUtilityScripts,
      loadAssetDocument,
      collectPlayUiLibrary,
      collectPlayAnimGraphs,
      collectPlayBehaviourTrees,
      collectPlayBlackboards,
      collectPlaySpritePayloads,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayModelBytes,
      collectPlaySceneLibrary,
      loadGraphDocument,
      lastCompiledSignature,
      markScriptsCurrent,
      listedProjects,
      needsReconnect,
      recoveryAvailable,
      migrationPending,
      templates,
      refreshTemplates,
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      renameListedProject,
      removeListedProject,
      reconnectProject,
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      closeProject,
      forceCloseProject,
      refreshProjectList,
      exportProject,
      dismissRecovery,
      keepRecovery,
      openDocument,
      pendingExclusiveScene,
      confirmExclusiveSceneOpen,
      cancelExclusiveSceneOpen,
      closeDocument,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
      updateScene,
      updateGraph,
      applyGraphChange,
      applySceneChange,
      applyAssetDocumentChange,
      readAssetChunk,
      writeSceneNavmeshChunk,
      updateProjectSettings,
      undoActiveDocument,
      redoActiveDocument,
      registerDockviewApi,
      activateDockPanel,
      toggleDockWindow,
      isDockWindowOpen,
      getOpenDockWindowCount,
      captureActiveLayout,
      toggleLayoutFocus,
      focusedLayoutIds,
      getAvailableDocuments,
    ],
  );

  return (
    <DocumentContext.Provider value={value}>
      <DockWindowTickContext.Provider value={dockWindowTick}>
        {children}
      </DockWindowTickContext.Provider>
    </DocumentContext.Provider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export function useDocuments(): DocumentContextValue {
  const context = useContext(DocumentContext);
  if (!context) {
    throw new Error("useDocuments must be used within DocumentProvider");
  }
  return context;
}

export function useDockWindowTick(): number {
  return useContext(DockWindowTickContext);
}

/** @deprecated Use useDocuments instead */
export function useProject(): DocumentContextValue {
  return useDocuments();
}

/** @deprecated Use DocumentProvider instead */
export const ProjectProvider = DocumentProvider;
/* eslint-enable react-refresh/only-export-components */
