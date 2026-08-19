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
import { flushSync } from "react-dom";
import type {
  AssetDocumentKind,
  DocumentRef,
  ProjectDocument,
  ProjectFolderHandle,
  Result,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import { documentId, isAssetDocumentKind, normalizeProjectSettings, normalizeScene, DEFAULT_RENDER_PROJECT_SETTINGS, DEFAULT_PLAY_FRAME_CAP, DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@babylonslate/core";
import {
  appendJournalLine,
  getTile,
  hasJournal,
  normalizeTilemapPayload,
  readJournalLines,
  readThumbnail,
  ThumbnailDecodeLru,
  truncateJournal,
  collectAudioClipSourceBytes,
  type AssetRegistry,
  type MigrationPending,
  type PluginDescriptor,
  type PluginDiagnostic,
  type ProjectSearchIndex,
  type ProjectTemplate,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
  resolvePluginEnabled,
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
  createSecretStore,
  createNativeHttp,
} from "@babylonslate/vfs";
import type { ProjectStorage } from "@babylonslate/core";
import type { ScriptBundleEntry, UiWidgetEventKind } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import {
  DocumentService,
  type OpenDocument,
} from "../services/document-service";
import { ProjectService, type PluginImportResult } from "../services/project-service";
import type { GitConfigPrefill } from "@babylonslate/source-control";
import {
  readGitPrefill,
  SourceControlService,
} from "../services/source-control-service";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import {
  afterMutatingApply,
  isMutatingApplyBlocked,
} from "../lib/document-lock-apply";
import { dirtyScenesBlockingOpen } from "../lib/exclusive-scene";
import { notifyDocumentEdited } from "../lib/notify-document-edited";
import { shouldApplyAssetDocumentChange } from "../lib/asset-document-change";
import { ensureEnginePluginStorage, lastEnginePluginLoad } from "../lib/engine-plugins";
import { loadTemplateCards } from "../services/template-service";
import {
  compileAnimGraphScripts,
  compileGraphDocuments,
  classIdForGraphPath,
  graphCompileSignature,
  graphsNeedCompile as compileSignatureIsStale,
} from "../services/script-compiler";
import type { CreateProjectOptions } from "../lib/create-project";
import type { ExportArtifact } from "@babylonslate/exporter";
import {
  assetsFromIndexed,
  collectAndExportGame,
  zipGameArtifact,
} from "../services/export-game";
import { loadExportDocuments } from "../services/export-game-inputs";
import { loadPlayerDistFiles } from "../services/load-player-files";
import { flushAudioReverbForSave } from "../lib/audio-reverb-bake";
import {
  classHierarchyFromParentOf,
  classMemberSymbolsFromGraphs,
  knownClassIdSet,
  validateSerializedGraph,
} from "../services/graph-validation";
import { collectClassGraphsForPalette, collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";
import { applyFocusLayout, focusKeepPanelIds } from "../shell/layout-ops";
import {
  capturePanelPlacement,
  isDockWindowOpen as isDockWindowOpenOnApi,
  listDockPanels,
  openDockWindow,
  toggleDockWindow as toggleDockWindowOnApi,
  type DockWindowApi,
  type PanelPlacement,
} from "../shell/dock-window-ops";
import {
  isDockviewDocumentKind,
  listDockWindows,
  type DockWindowOptions,
} from "../shell/window-catalog";
import {
  applyPreFocusToUiLayout,
  parseUiDocumentLayout,
  serializeUiDocumentLayout,
  type PreFocusSnapshot,
  type UiEditorMode,
} from "../shell/ui-document-layout";
import {
  applyPreFocusToAnimLayout,
  parseAnimDocumentLayout,
  serializeAnimDocumentLayout,
  type AnimEditorMode,
} from "../shell/anim-document-layout";
import {
  dockviewApiKey,
  dockviewApiKeysForDocument,
  dockviewSurfaceForAnimMode,
  dockviewSurfaceForUiMode,
  type DockviewSurface,
} from "../shell/dockview-surface";
import { resetProjectUiAssets } from "../lib/project-ui-asset-cache";
import { editorKtx2PublicBase } from "../lib/public-engine-assets";
import { asDevicePresets } from "../lib/engine-ui-presets";
import {
  classDocumentShowsPrefab,
  classParentLookup,
} from "../lib/content-browser-helpers";
import {
  classAssetPaths,
  createProjectPluginAndRevealContent,
  isPluginDocumentReadOnly,
  mergePluginEditorUtilityObjects,
  playSceneLibraryPaths,
} from "../lib/plugin-ui";
import { readProjectJsonMtime, refreshMtimeSnapshotAfterEditorSave } from "../lib/external-change";
import {
  classifyExternalChanges,
  snapshotIndexedMtimes,
  type ExternalChangeClassification,
} from "@babylonslate/assets";
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
  collectAnimGraphCompileDocuments,
  playAnimGraphsFromGuids,
  playAnimGraphsFromOpenDocuments,
  playBehaviourTreesFromGuids,
  playBehaviourTreesFromOpenDocuments,
  playBlackboardsFromGuids,
  playBlackboardsFromOpenDocuments,
  playSpriteAnimationPayloadsFromGuids,
  playSpritePayloadsFromGuids,
  spriteAnimationGuidsFromAnimGraphs,
  playTilemapPayloadsFromGuids,
  playTilesetPayloadsFromGuids,
  playUiLibraryFromAssets,
  preferOpenPlayUiContent,
  collectPlayScriptDocuments,
  dispatchMountedPlayUiWidgetEvent,
  spriteAssetGuidsFromScene,
  tilemapAssetGuidsFromScene,
  tilesetGuidsFromTilemaps,
  textureGuidsFromPlayPayloads,
  modelAssetGuidsFromScene,
  playMaterialGuidsFromSources,
  materialClosureFromGuids,
  type PlayAnimGraphEntry,
  type PlayBehaviourTreeEntry,
  type PlayBlackboardEntry,
} from "../lib/play-content";
import { playAudioLibraryFromAssets } from "../lib/play-audio";
import {
  playParticleLibraryFromAssets,
} from "../lib/play-particles";
import { materialPreviewCameraRadius } from "../lib/material-preview-test-host";
import {
  clearDocumentDirtyTrace,
  documentDirtyTrace,
  recordSaveAllTrace,
  saveAllTrace,
} from "../lib/dirty-trace";
import { animClipCatalogFromAssets } from "../lib/anim-clip-catalog";
import {
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
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
  pluginDescriptors: PluginDescriptor[];
  pluginDiagnostics: PluginDiagnostic[];
  showPluginContent: boolean;
  setShowPluginContent: (show: boolean) => void;
  applyPluginOverrides: (
    overrides: Record<string, { enabled: boolean }>,
  ) => Promise<void>;
  createProjectPlugin: (displayName: string) => Promise<PluginDescriptor>;
  deleteProjectPlugin: (guid: string) => Promise<void>;
  exportPlugin: (guid: string) => Promise<Uint8Array>;
  importPlugin: (
    bytes: Uint8Array,
    decision?: "keep" | "replace",
  ) => Promise<PluginImportResult>;
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
  onSessionDiagnostic: (listener: (line: string) => void) => () => void;
  sessionDiagnostics: string[];
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
  exportGameArtifact: (options?: {
    previewBuild?: boolean;
    playerFiles?: Map<string, Uint8Array>;
    onPhase?: (phase: "Compiling" | "Writing Pack") => void;
  }) => Promise<Result<ExportArtifact, string>>;
  zipExportedGame: (artifact: ExportArtifact) => Uint8Array;
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
  writeAudioClipChunk: (
    path: string,
    chunkId: string,
    bytes: Uint8Array,
    mime: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  removeAudioClipChunk: (
    path: string,
    chunkId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** Write Recast bake bytes onto the Scene asset extra chunk. */
  writeSceneNavmeshChunk: (
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  writeSceneAudioReverbChunk: (
    path: string,
    bytes: Uint8Array,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** Persist project.json settings (Input, 2D units, textures, …). */
  updateProjectSettings: (settings: Partial<ProjectDocument["settings"]>) => void;
  sourceControl: SourceControlService;
  prefillSourceControlFromGit: () => Promise<GitConfigPrefill>;
  externalChangePrompt: ExternalChangeClassification | null;
  confirmExternalChangeReloadProject: () => Promise<void>;
  confirmExternalChangeReloadDocs: (paths: string[]) => Promise<void>;
  dismissExternalChange: () => void;
  undoActiveDocument: () => void;
  redoActiveDocument: () => void;
  canUndoActiveDocument: boolean;
  canRedoActiveDocument: boolean;
  registerDockviewApi: (
    id: string,
    api: DockviewApi,
    surface?: DockviewSurface,
  ) => void;
  uiEditorMode: UiEditorMode;
  setUiEditorMode: (id: string, mode: UiEditorMode) => void;
  animEditorMode: AnimEditorMode;
  setAnimEditorMode: (id: string, mode: AnimEditorMode) => void;
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
    graphs?: readonly PlayAnimGraphEntry[],
  ) => Promise<Map<string, SpritePayload>>;
  /** Sprite Animation clips referenced by loaded Animation Graphs. */
  collectPlaySpriteAnimationPayloads: (
    graphs: readonly PlayAnimGraphEntry[],
  ) => Promise<Map<string, SpriteAnimationPayload>>;
  collectPlayTilemapContent: (
    scene?: SerializedScene | null,
  ) => Promise<{
    tilemaps: Map<string, TilemapPayload>;
    tilesets: Map<string, TilesetPayload>;
  }>;
  /** Texture pixels/source bytes for sprite, tileset, and material `textureGuid`s. */
  collectPlayTextureBytes: (
    sprites: ReadonlyMap<string, SpritePayload>,
    tilesets: ReadonlyMap<string, TilesetPayload>,
    extraGuids?: readonly string[],
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
  ) => Promise<Map<string, Uint8Array>>;
  /** Model source bytes for scene MeshComponent `assetGuid`s. */
  collectPlayModelBytes: (
    scene?: SerializedScene | null,
  ) => Promise<Map<string, Uint8Array>>;
  /** Audio source bytes and mixer/channel/attenuation library for Play. */
  collectPlayAudio: () => Promise<{
    bytes: Map<string, Uint8Array>;
    library: import("../lib/play-audio").PlayAudioLibrary;
  }>;
  /** Surface, post-process, and HUD Interface materials plus transitive Material Functions. */
  collectPlayMaterialLibrary: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
    extraMaterialGuids?: readonly string[],
  ) => Promise<{
    documents: Map<string, MaterialDocument>;
    functions: Map<string, MaterialFunctionDocument>;
    textureGuids: string[];
  }>;
  collectPlayParticles: () => Promise<
    import("../lib/play-particles").PlayParticleLibrary
  >;
  /** Mounted Scene assets (all roots) so Play `changescene` can instantiate them. */
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

function dockOptionsForIndexed(
  kind: string,
  indexed:
    | { header: { type: string; parentClass?: string | null } }
    | undefined,
  parentOf: (id: string) => string | null | undefined,
  sourceControlEnabled = false,
  uiEditorMode?: UiEditorMode,
  animEditorMode?: AnimEditorMode,
): DockWindowOptions {
  return {
    actorPrefab:
      kind !== "graph" ||
      !indexed ||
      classDocumentShowsPrefab(indexed.header.parentClass, parentOf, {
        assetType: indexed.header.type,
      }),
    sourceControl: sourceControlEnabled,
    uiEditorMode: kind === "ui" ? (uiEditorMode ?? "designer") : undefined,
    animEditorMode:
      kind === "anim-graph" ? (animEditorMode ?? "stateMachine") : undefined,
  };
}

function animEditorModeForDocument(
  id: string,
  modes: Record<string, AnimEditorMode>,
  doc: OpenDocument | undefined,
): AnimEditorMode {
  if (modes[id]) return modes[id];
  if (doc?.ref.kind === "anim-graph") {
    return parseAnimDocumentLayout(doc.layout).animEditorMode;
  }
  return "stateMachine";
}

function uiEditorModeForDocument(
  id: string,
  modes: Record<string, UiEditorMode>,
  doc: OpenDocument | undefined,
): UiEditorMode {
  if (modes[id]) return modes[id];
  if (doc?.ref.kind === "ui") {
    return parseUiDocumentLayout(doc.layout).uiEditorMode;
  }
  return "designer";
}

function findWindowDefinition(
  kind: string,
  panelId: string,
  dockOptions: DockWindowOptions = {},
) {
  if (!isDockviewDocumentKind(kind)) return undefined;
  return listDockWindows(kind, dockOptions).find((entry) => entry.id === panelId);
}

function restorePreFocusSnapshot(
  id: string,
  snapshot: PreFocusSnapshot,
  apis: Map<string, DockviewApi>,
): void {
  const api =
    apis.get(dockviewApiKey(id, snapshot.surface)) ?? apis.get(id);
  api?.fromJSON(snapshot.layout as never);
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
  const dockviewApisRef = useRef(new Map<string, DockviewApi>());
  const dockSubscriptionsRef = useRef(new Map<string, Array<{ dispose: () => void }>>());
  const preFocusLayoutsRef = useRef(new Map<string, PreFocusSnapshot>());
  const [uiEditorModes, setUiEditorModes] = useState<Record<string, UiEditorMode>>(
    {},
  );
  const [animEditorModes, setAnimEditorModes] = useState<
    Record<string, AnimEditorMode>
  >({});
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
  const bumpDockWindows = useCallback(() => {
    setDockWindowTick((v) => v + 1);
  }, []);
  const documentService = documentServiceRef.current;
  const runForegroundRescanRef = useRef<() => Promise<void>>(async () => {});

  const captureMtimeSnapshot = useCallback(async () => {
    mtimeSnapshotRef.current = {
      assets: snapshotIndexedMtimes(projectService.registry?.list() ?? []),
      projectJson: await readProjectJsonMtime(projectService.storagePort),
    };
  }, [projectService]);

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

  useEffect(() => {
    return attachLifecyclePause((paused) => {
      if (paused) {
        sourceControlRef.current.pausePolling();
        return;
      }
      sourceControlRef.current.resumePolling();
      void runForegroundRescanRef.current();
    });
  }, []);

  const disposeDockSubscriptions = useCallback((id?: string) => {
    const keys = id
      ? [id, ...dockviewApiKeysForDocument(id)].filter(
          (key, index, all) => all.indexOf(key) === index,
        )
      : [...dockSubscriptionsRef.current.keys()];
    for (const key of keys) {
      for (const sub of dockSubscriptionsRef.current.get(key) ?? []) {
        sub.dispose();
      }
      dockSubscriptionsRef.current.delete(key);
    }
    if (!id) dockSubscriptionsRef.current.clear();
  }, []);

  const ensureDerived = useCallback(async () => {
    if (!derivedStorageRef.current) {
      derivedStorageRef.current = await createDerivedStorage();
    }
    return derivedStorageRef.current;
  }, []);

  const recordRecent = useCallback(
    async (handle: ProjectFolderHandle | null, createdAt?: string) => {
      if (!handle) return;
      const settings = await settingsStore.load();
      const next = defaultEngineSettings();
      Object.assign(next, settings);
      const previous = settings.recents.find((recent) => recent.id === handle.id);
      next.recents = [
        {
          id: handle.id,
          name: handle.name,
          tier: handle.tier,
          lastOpenedAt: new Date().toISOString(),
          createdAt: createdAt ?? previous?.createdAt,
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
      const doc = documentService.getDocument(id);
      if (doc?.ref.kind === "ui") {
        const parsed = parseUiDocumentLayout(doc.layout);
        const mode = uiEditorModeForDocument(id, uiEditorModes, doc);
        const designerApi = dockviewApisRef.current.get(
          dockviewApiKey(id, "designer"),
        );
        const logicApi = dockviewApisRef.current.get(dockviewApiKey(id, "logic"));
        const live: typeof parsed = {
          uiEditorMode: mode,
          designer: designerApi
            ? projectService.captureLayout(designerApi)
            : parsed.designer,
          logic: logicApi
            ? projectService.captureLayout(logicApi)
            : parsed.logic,
        };
        const preFocus = preFocusLayoutsRef.current.get(id);
        documentService.setLayout(
          id,
          serializeUiDocumentLayout(
            preFocus ? applyPreFocusToUiLayout(live, preFocus) : live,
          ),
        );
        return;
      }
      if (doc?.ref.kind === "anim-graph") {
        const parsed = parseAnimDocumentLayout(doc.layout);
        const mode = animEditorModeForDocument(id, animEditorModes, doc);
        const stateApi = dockviewApisRef.current.get(
          dockviewApiKey(id, "stateMachine"),
        );
        const objectApi = dockviewApisRef.current.get(
          dockviewApiKey(id, "animationObject"),
        );
        const live = {
          animEditorMode: mode,
          stateMachine: stateApi
            ? projectService.captureLayout(stateApi)
            : parsed.stateMachine,
          animationObject: objectApi
            ? projectService.captureLayout(objectApi)
            : parsed.animationObject,
        };
        const animPreFocus = preFocusLayoutsRef.current.get(id);
        documentService.setLayout(
          id,
          serializeAnimDocumentLayout(
            animPreFocus
              ? applyPreFocusToAnimLayout(live, animPreFocus)
              : live,
          ),
        );
        return;
      }
      const preFocus = preFocusLayoutsRef.current.get(id);
      if (preFocus) {
        documentService.setLayout(id, preFocus.layout);
        return;
      }
      const api = dockviewApisRef.current.get(id);
      if (api) {
        documentService.setLayout(id, projectService.captureLayout(api));
      }
    },
    [documentService, projectService, uiEditorModes, animEditorModes],
  );

  const captureAllLayouts = useCallback(() => {
    const { tabOrder } = documentService.getState();
    for (const id of tabOrder) {
      captureLayoutForId(id);
    }
  }, [captureLayoutForId, documentService]);

  const refreshAssetRegistry = useCallback(async () => {
    await projectService.remountRegistry();
    const paths = projectService.registry?.listDocumentPaths({ rootId: "project" });
    if (projectDocument && paths) {
      setProjectDocument({
        ...projectDocument,
        scenes: paths.scenes,
        graphs: paths.graphs,
      });
    }
    bump();
  }, [bump, projectDocument, projectService]);

  const reloadDocumentsFromDisk = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.path === path,
        );
        if (!doc || doc.ref.kind === "content-browser") continue;
        try {
          const content = await projectService.loadDocument(
            doc.ref.kind,
            doc.ref.path,
          );
          documentService.replaceLoadedContent(doc.id, content);
          editSessionRef.current.dropDocument(doc.id);
        } catch {
          // Deleted or unreadable on disk.
        }
      }
      bump();
    },
    [bump, documentService, projectService],
  );

  const runForegroundRescan = useCallback(async () => {
    if (!projectDocumentRef.current) return;
    const previous = mtimeSnapshotRef.current;
    await projectService.remountRegistry();
    bump();
    const nextAssets = snapshotIndexedMtimes(
      projectService.registry?.list() ?? [],
    );
    const nextProject = await readProjectJsonMtime(projectService.storagePort);
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
    mtimeSnapshotRef.current = {
      assets: nextAssets,
      projectJson: nextProject,
    };
  }, [bump, documentService, projectService]);
  runForegroundRescanRef.current = runForegroundRescan;

  const confirmExternalChangeReloadProject = useCallback(async () => {
    const { document } = await projectService.loadCurrentProject();
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
  ]);

  const confirmExternalChangeReloadDocs = useCallback(
    async (paths: string[]) => {
      await reloadDocumentsFromDisk(paths);
      setExternalChangePrompt(null);
    },
    [reloadDocumentsFromDisk],
  );

  const dismissExternalChange = useCallback(() => {
    setExternalChangePrompt(null);
  }, []);

  const applyPluginOverrides = useCallback(
    async (overrides: Record<string, { enabled: boolean }>) => {
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

  const onSessionDiagnostic = useCallback(
    (listener: (line: string) => void) => projectService.onDiagnostic(listener),
    [projectService],
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
      setUiEditorModes({});
      setAnimEditorModes({});
      resetProjectUiAssets();
      const { probeKtx2TranscoderAvailable } = await import(
        "@babylonslate/render"
      );
      const transcoderOk = await probeKtx2TranscoderAvailable(
        editorKtx2PublicBase(),
      );
      await projectService.setTranscoderAvailable(transcoderOk);
      const derived = await ensureDerived();
      projectService.setDerivedStorage(derived);
      const guid = projectService.guid;
      if (guid) {
        setRecoveryAvailable(await hasJournal(derived, guid));
      }
      await recordRecent(
        projectService.storagePort.getCurrentFolder(),
        document.metadata.createdAt,
      );
      await refreshProjectList();
      await captureMtimeSnapshot();
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
      captureMtimeSnapshot,
    ],
  );

  const attachEnginePlugins = useCallback(async () => {
    const storage = await ensureEnginePluginStorage();
    projectService.setEnginePluginStorage(storage);
  }, [projectService]);

  useEffect(() => {
    void attachEnginePlugins();
  }, [attachEnginePlugins]);

  const openProject = useCallback(async () => {
    await attachEnginePlugins();
    const { document, layouts, migrationPending: pending } =
      await projectService.openProject();
    await enterEditor(document, layouts, pending);
  }, [attachEnginePlugins, enterEditor, projectService]);

  const createEmptyProject = useCallback(
    async (name: string, options?: CreateProjectOptions) => {
      await attachEnginePlugins();
      const { document, layouts, migrationPending: pending } =
        await projectService.createEmptyProject(name, options);
      await enterEditor(document, layouts, pending);
    },
    [attachEnginePlugins, enterEditor, projectService],
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
      await attachEnginePlugins();
      const { document, layouts, migrationPending: pending } =
        await projectService.createFromTemplate({
          templateFiles: template.files,
          name,
          pickFolder: options?.pickFolder,
        });
      await enterEditor(document, layouts, pending);
    },
    [attachEnginePlugins, enterEditor, projectService, templates],
  );

  const openListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      await attachEnginePlugins();
      const { document, layouts, migrationPending: pending } =
        await projectService.openListedProject(handle);
      await enterEditor(document, layouts, pending);
    },
    [attachEnginePlugins, enterEditor, projectService],
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
    await attachEnginePlugins();
    const { document, layouts, migrationPending: pending } =
      await projectService.reconnect();
    await enterEditor(document, layouts, pending);
  }, [attachEnginePlugins, enterEditor, projectService]);

  const saveProject = useCallback(async (): Promise<boolean> => {
    const document = projectDocumentRef.current;
    const dirtyBefore = documentService.getDirtyDocuments().length;
    if (!document) {
      recordSaveAllTrace({
        ok: false,
        reason: "no-document",
        dirtyBefore,
        dirtyAfter: dirtyBefore,
      });
      return false;
    }
    if (projectService.pendingMigrations.length > 0) {
      setMigrationPending(projectService.pendingMigrations);
      recordSaveAllTrace({
        ok: false,
        reason: "migrations",
        dirtyBefore,
        dirtyAfter: dirtyBefore,
      });
      // Caller must use approveMigrationsAndSave — never silently rewrite.
      return false;
    }
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    try {
      await flushAudioReverbForSave();
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
      await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
      const guid = projectService.guid;
      if (guid) {
        const derived = await ensureDerived();
        await truncateJournal(derived, guid);
        setRecoveryAvailable(false);
      }
      if (savedScene) {
        emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.sceneSaved);
      }
      flushSync(() => {
        bump();
      });
      recordSaveAllTrace({
        ok: true,
        reason: "saved",
        dirtyBefore,
        dirtyAfter: documentService.getDirtyDocuments().length,
      });
      return true;
    } catch (error) {
      recordSaveAllTrace({
        ok: false,
        reason: "error",
        dirtyBefore,
        dirtyAfter: documentService.getDirtyDocuments().length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, [
    bump,
    captureAllLayouts,
    captureMtimeSnapshot,
    documentService,
    ensureDerived,
    projectService,
  ]);

  const scheduleDebouncedSave = useCallback(() => {
    if (saveDebounceRef.current) return;
    const interval =
      projectDocumentRef.current?.settings.autoSaveIntervalMs ?? 120_000;
    saveDebounceRef.current = setTimeout(() => {
      saveDebounceRef.current = null;
      void saveProject();
    }, interval);
  }, [saveProject]);

  const setShowPluginContent = useCallback(
    (show: boolean) => {
      documentService.setShowPluginContent(show);
      scheduleDebouncedSave();
      bump();
    },
    [bump, documentService, scheduleDebouncedSave],
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
    await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
    bump();
  }, [
    bump,
    captureAllLayouts,
    captureMtimeSnapshot,
    documentService,
    projectDocument,
    projectService,
  ]);

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
    sourceControlRef.current.dispose();
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
    setUiEditorModes({});
    setAnimEditorModes({});
    resetProjectUiAssets();
    mtimeSnapshotRef.current = null;
    setExternalChangePrompt(null);
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

  const exportGameArtifact = useCallback(
    async (options?: {
      previewBuild?: boolean;
      playerFiles?: Map<string, Uint8Array>;
      onPhase?: (phase: "Compiling" | "Writing Pack") => void;
    }) => {
      const list = projectService.registry?.list() ?? [];
      await flushAudioReverbForSave();
      const loaded = await loadExportDocuments({
        assets: list,
        loadDocument: (kind, path) =>
          projectService.loadDocument(
            kind as Parameters<ProjectService["loadDocument"]>[0],
            path,
          ),
        readAssetChunk: (path, chunkId) =>
          projectService.readAssetChunk(path, chunkId),
      });
      const playerFiles = options?.playerFiles ?? (await loadPlayerDistFiles());
      const engineSettings = await settingsStore.load();
      return collectAndExportGame({
        startupSceneGuid: projectDocument?.settings.startupSceneGuid ?? null,
        gameInstanceClass: projectDocument?.settings.gameInstanceClass ?? null,
        audioMixerGuid: projectDocument?.settings.audio.audioMixerGuid ?? null,
        occlusionEnabled:
          projectDocument?.settings.audio.occlusionEnabled !== false,
        reverbWetScale: projectDocument?.settings.audio.reverbWetScale,
        reverbDecayScale: projectDocument?.settings.audio.reverbDecayScale,
        reverbDampingScale: projectDocument?.settings.audio.reverbDampingScale,
        assets: assetsFromIndexed(list),
        plugins: projectService.plugins.map((plugin) => ({
          pluginGuid: plugin.pluginGuid,
          enabledByDefault: plugin.settings.enabledByDefault,
        })),
        projectPluginOverrides: projectDocument?.settings.pluginOverrides ?? {},
        preset: projectDocument?.settings.exportPresets[0],
        parentOf: classParentLookup(list),
        sceneByGuid: loaded.sceneByGuid,
        graphByGuid: loaded.graphByGuid,
        payloadByGuid: loaded.payloadByGuid,
        bytesByGuid: loaded.bytesByGuid,
        guiImageBytesByGuid: loaded.guiImageBytesByGuid,
        navmeshByGuid: loaded.navmeshByGuid,
        audioReverbByGuid: loaded.audioReverbByGuid,
        customResolution:
          projectDocument?.settings.render ?? DEFAULT_RENDER_PROJECT_SETTINGS,
        playFrameCap:
          projectDocument?.settings.playFrameCap ?? DEFAULT_PLAY_FRAME_CAP,
        pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit ?? 100,
        pixelPerfect: projectDocument?.settings.twoD.pixelPerfect === true,
        physicsWorld:
          loaded.sceneByGuid(
            projectDocument?.settings.startupSceneGuid ?? "",
          )?.settings.physicsWorld === "2d"
            ? "2d"
            : "3d",
        infiniteLoopDetection:
          projectDocument?.settings.infiniteLoopDetection,
        loopCount: projectDocument?.settings.loopCount,
        playerFiles,
        previewBuild: options?.previewBuild,
        onPhase: options?.onPhase,
        uiDesignerPresets: asDevicePresets(engineSettings.uiDesignerPresets),
      });
    },
    [projectDocument, projectService, settingsStore],
  );

  const zipExportedGame = useCallback((artifact: ExportArtifact) => {
    return zipGameArtifact(artifact);
  }, []);

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
      for (const key of dockviewApiKeysForDocument(id)) {
        dockviewApisRef.current.delete(key);
      }
      disposeDockSubscriptions(id);
      preFocusLayoutsRef.current.delete(id);
      setUiEditorModes((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      setAnimEditorModes((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
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
      sourceControlRef.current.onOpenDocument(ref.path);
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
            audio: {
              ...current.settings.audio,
              ...settings.audio,
            },
            sourceControl: {
              ...current.settings.sourceControl,
              ...settings.sourceControl,
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

  const prefillSourceControlFromGit = useCallback(async () => {
    return readGitPrefill(projectService.storagePort);
  }, [projectService]);

  const applyGraphChange = useCallback(
    async (id: string, next: SerializedGraph): Promise<boolean> => {
      const doc = documentService.getState().openDocuments.get(id);
      if (!doc || doc.ref.kind !== "graph" || !doc.content) {
        return false;
      }
      if (isMutatingApplyBlocked(
        sourceControlRef.current,
        doc.ref.path,
        isPluginDocumentReadOnly(projectService.plugins, doc.ref.path),
      )) {
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
      void afterMutatingApply(sourceControlRef.current, doc.ref.path);
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
      if (isMutatingApplyBlocked(
        sourceControlRef.current,
        doc.ref.path,
        isPluginDocumentReadOnly(projectService.plugins, doc.ref.path),
      )) {
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
      void afterMutatingApply(sourceControlRef.current, doc.ref.path);
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
      if (isMutatingApplyBlocked(
        sourceControlRef.current,
        doc.ref.path,
        isPluginDocumentReadOnly(projectService.plugins, doc.ref.path),
      )) {
        return false;
      }
      const previous = doc.content as Record<string, unknown>;
      if (!shouldApplyAssetDocumentChange(previous, next)) {
        return false;
      }
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
      void afterMutatingApply(sourceControlRef.current, doc.ref.path);
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

  const loadClassGraphDocuments = useCallback(async (): Promise<
    Array<{ path: string; content: SerializedGraph }>
  > => {
    const paths = classAssetPaths(projectService.registry?.list() ?? []);
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
  }, [documentService, projectService]);

  const loadProjectGraphDocuments = useCallback(async (): Promise<
    Array<{
      path: string;
      content: SerializedGraph;
      classId?: string;
      parentClassId?: string | null;
    }>
  > => {
    const documents = await loadClassGraphDocuments();
    const open = documentService.getState().openDocuments;
    const uiAssets = (projectService.registry?.list() ?? []).filter(
      (asset) => asset.header.type === "UserInterface",
    );
    const uiPayloads: Array<{ path: string; payload: unknown; guid?: string }> = [];
    for (const asset of uiAssets) {
      const openDoc = open.get(documentId({ kind: "ui", path: asset.path }));
      if (openDoc?.content) {
        uiPayloads.push({
          path: asset.path,
          payload: openDoc.content,
          guid: asset.header.guid,
        });
        continue;
      }
      try {
        uiPayloads.push({
          path: asset.path,
          payload: await projectService.loadDocument("ui", asset.path),
          guid: asset.header.guid,
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

  const loadProjectAnimGraphDocuments = useCallback(async () => {
    const assets = (projectService.registry?.list() ?? []).filter(
      (asset) => asset.header.type === "AnimationGraph",
    );
    const open = documentService.getState().openDocuments;
    const entries: PlayAnimGraphEntry[] = [];
    for (const asset of assets) {
      const openDoc = open.get(
        documentId({ kind: "anim-graph", path: asset.path }),
      );
      if (openDoc?.content) {
        entries.push({ guid: asset.header.guid, document: openDoc.content });
        continue;
      }
      try {
        entries.push({
          guid: asset.header.guid,
          document: await projectService.loadDocument("anim-graph", asset.path),
        });
      } catch (error) {
        console.error(
          `[play] failed to load AnimationGraph ${asset.path}`,
          error,
        );
      }
    }
    return collectAnimGraphCompileDocuments(
      entries,
      (guid) => assets.find((asset) => asset.header.guid === guid)?.path ?? null,
    );
  }, [documentService, projectService]);

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
    const registered = mergePluginEditorUtilityObjects(
      projectDocumentRef.current?.settings.editorUtilityObjects ?? [],
      projectService.plugins
        .filter((plugin) =>
          resolvePluginEnabled(
            plugin.settings.enabledByDefault,
            projectDocumentRef.current?.settings.pluginOverrides[plugin.pluginGuid]
              ?.enabled,
          ),
        )
        .map((plugin) => plugin.settings),
    );
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
    const animDocuments = await loadProjectAnimGraphDocuments();
    const typeSchemas = typeSchemasFromGraphAssets(
      collectGraphTypeAssets({
        assets: projectService.registry?.list() ?? [],
        openDocuments: [...documentService.getState().openDocuments.values()],
      }),
    );
    const bundles = [
      ...compileGraphDocuments(documents, {
        enums: typeSchemas.enums,
        structs: typeSchemas.structs,
      }),
      ...compileAnimGraphScripts(animDocuments),
    ];
    markScriptsCurrent();
    return bundles;
  }, [
    documentService,
    loadProjectAnimGraphDocuments,
    loadProjectGraphDocuments,
    markScriptsCurrent,
    projectService,
  ]);

  const collectPlayPreviewScripts = useCallback(async (): Promise<{
    bundles: ScriptBundleEntry[];
    diagnostics: Diagnostic[];
  }> => {
    const documents = await loadProjectGraphDocuments();
    const animDocuments = await loadProjectAnimGraphDocuments();
    const parentOf = classParentLookup(projectService.registry?.list() ?? []);
    const classGraphs = collectClassGraphsForPalette({
      assets: projectService.registry?.list() ?? [],
      openDocuments: [...documentService.getState().openDocuments.values()],
      classIdForPath: classIdForGraphPath,
    });
    for (const doc of documents) {
      classGraphs[classIdForGraphPath(doc.path)] = doc.content;
    }
    const typeSchemas = typeSchemasFromGraphAssets(
      collectGraphTypeAssets({
        assets: projectService.registry?.list() ?? [],
        openDocuments: [...documentService.getState().openDocuments.values()],
      }),
    );
    const diagnostics = documents.flatMap((doc) =>
      validateSerializedGraph(doc.content, {
        assetGuid: doc.path,
        graphId: documentId({ kind: "graph", path: doc.path }),
        classId: doc.classId ?? classIdForGraphPath(doc.path),
        hierarchy: classHierarchyFromParentOf(parentOf),
        members: classMemberSymbolsFromGraphs(classGraphs),
        knownClassIds: knownClassIdSet(parentOf, Object.keys(classGraphs)),
        enums: typeSchemas.enums,
        structs: typeSchemas.structs,
      }),
    );
    const bundles = [
      ...compileGraphDocuments(documents, {
        enums: typeSchemas.enums,
        structs: typeSchemas.structs,
      }),
      ...compileAnimGraphScripts(animDocuments),
    ];
    markScriptsCurrent();
    return { bundles, diagnostics };
  }, [
    documentService,
    loadProjectAnimGraphDocuments,
    loadProjectGraphDocuments,
    markScriptsCurrent,
    projectService,
  ]);

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
      let disk: unknown | null = null;
      if (!openDoc?.content) {
        try {
          disk = await projectService.loadDocument("ui", asset.path);
        } catch (error) {
          console.error(`[play] failed to load UserInterface ${asset.path}`, error);
        }
      }
      const content = preferOpenPlayUiContent(openDoc?.content, disk);
      if (content) loaded.set(asset.path, content);
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
        | "sprite-animation"
        | "ui"
        | "tileset"
        | "tilemap"
        | "material"
        | "material-function"
        | "audio-mixer"
        | "audio-channel"
        | "sound-attenuation"
        | "particle-emitter"
        | "particle-system"
        | "audio"
        | "asset-settings",
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
      const clipCatalog = animClipCatalogFromAssets(assets);
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "AnimationGraph")
          .map((asset) => [asset.header.guid, asset]),
      );
      const openEntries = playAnimGraphsFromOpenDocuments(
        [...documentService.getState().openDocuments.values()],
        (path) =>
          assets.find((asset) => asset.path === path)?.header.guid ?? null,
        clipCatalog,
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
        playAnimGraphsFromGuids(
          [...needed],
          (guid) => loaded.get(guid) ?? null,
          clipCatalog,
        ),
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
      graphs: readonly PlayAnimGraphEntry[] = [],
    ): Promise<Map<string, SpritePayload>> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "Sprite")
          .map((asset) => [asset.header.guid, asset]),
      );
      const loaded = new Map<string, unknown>();
      const needed = new Set([
        ...spriteAssetGuidsFromScene(scene),
        ...spriteAnimationGuidsFromAnimGraphs(graphs),
      ]);
      for (const guid of needed) {
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

  const collectPlaySpriteAnimationPayloads = useCallback(
    async (
      graphs: readonly PlayAnimGraphEntry[],
    ): Promise<Map<string, SpriteAnimationPayload>> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets
          .filter((asset) => asset.header.type === "SpriteAnimation")
          .map((asset) => [asset.header.guid, asset]),
      );
      const loaded = new Map<string, unknown>();
      for (const guid of spriteAnimationGuidsFromAnimGraphs(graphs)) {
        const asset = byGuid.get(guid);
        if (!asset) continue;
        const content = await loadPlayAssetContent(
          "sprite-animation",
          asset.path,
        );
        if (content) loaded.set(guid, content);
      }
      return playSpriteAnimationPayloadsFromGuids(
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
      extraGuids: readonly string[] = [],
      spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
    ): Promise<Map<string, Uint8Array>> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets.map((asset) => [asset.header.guid, asset] as const),
      );
      const bytes = new Map<string, Uint8Array>();
      const guids = [
        ...textureGuidsFromPlayPayloads(sprites, tilesets, spriteAnimations),
        ...extraGuids,
      ];
      const seen = new Set<string>();
      for (const guid of guids) {
        if (!guid || seen.has(guid)) continue;
        seen.add(guid);
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

  const collectPlayAudio = useCallback(async () => {
    const assets = projectService.registry?.list() ?? [];
    const audioAssets = assets.filter((asset) =>
      ["Audio", "AudioMixer", "AudioChannel", "SoundAttenuation"].includes(
        asset.header.type,
      ),
    );
    const payloads: Array<{ guid: string; type: string; payload: unknown }> = [];
    const bytes = new Map<string, Uint8Array>();
    for (const asset of audioAssets) {
      const kind =
        asset.header.type === "AudioMixer"
          ? "audio-mixer"
          : asset.header.type === "AudioChannel"
            ? "audio-channel"
            : asset.header.type === "SoundAttenuation"
              ? "sound-attenuation"
              : "audio";
      const content =
        (await loadPlayAssetContent(kind, asset.path)) ?? asset.header.payload;
      payloads.push({
        guid: asset.header.guid,
        type: asset.header.type,
        payload: content,
      });
      if (asset.header.type === "Audio") {
        const mapped = await collectAudioClipSourceBytes({
          assetGuid: asset.header.guid,
          payload: content,
          readChunk: (chunkId) =>
            projectService.readAssetChunk(asset.path, chunkId),
        });
        for (const [key, clipBytes] of mapped) {
          bytes.set(key, clipBytes);
        }
      }
    }
    return {
      bytes,
      library: playAudioLibraryFromAssets({
        mixerGuid: projectDocument?.settings.audio.audioMixerGuid ?? null,
        assets: payloads,
      }),
    };
  }, [loadPlayAssetContent, projectDocument, projectService]);

  const collectPlayParticles = useCallback(async () => {
    const assets = projectService.registry?.list() ?? [];
    const particleAssets = assets.filter((asset) =>
      ["ParticleEmitter", "ParticleSystem"].includes(asset.header.type),
    );
    const payloads: Array<{ guid: string; type: string; payload: unknown }> = [];
    for (const asset of particleAssets) {
      const kind =
        asset.header.type === "ParticleEmitter"
          ? "particle-emitter"
          : "particle-system";
      const content =
        (await loadPlayAssetContent(kind, asset.path)) ?? asset.header.payload;
      payloads.push({
        guid: asset.header.guid,
        type: asset.header.type,
        payload: content,
      });
    }
    return playParticleLibraryFromAssets({ assets: payloads });
  }, [loadPlayAssetContent, projectService]);

  const collectPlayMaterialLibrary = useCallback(
    async (
      scene?: SerializedScene | null,
      extraScenes: readonly SerializedScene[] = [],
      extraMaterialGuids: readonly string[] = [],
    ): Promise<{
      documents: Map<string, MaterialDocument>;
      functions: Map<string, MaterialFunctionDocument>;
      textureGuids: string[];
    }> => {
      const assets = projectService.registry?.list() ?? [];
      const byGuid = new Map(
        assets.map((asset) => [asset.header.guid, asset] as const),
      );
      const loaded = new Map<string, unknown>();
      const loadGuid = async (guid: string) => {
        if (loaded.has(guid)) return;
        const asset = byGuid.get(guid);
        if (!asset) return;
        const kind =
          asset.header.type === "MaterialFunction"
            ? "material-function"
            : asset.header.type === "Material"
              ? "material"
              : null;
        if (!kind) return;
        const content = await loadPlayAssetContent(kind, asset.path);
        if (content) loaded.set(guid, content);
      };
      const needed = new Set(
        playMaterialGuidsFromSources(
          [scene, ...extraScenes],
          [],
          extraMaterialGuids,
        ),
      );
      let grew = true;
      while (grew) {
        grew = false;
        for (const guid of [...needed]) await loadGuid(guid);
        const closure = materialClosureFromGuids([...needed], (guid) =>
          loaded.get(guid) ?? null,
        );
        for (const guid of [...closure.materials, ...closure.functions]) {
          if (needed.has(guid)) continue;
          needed.add(guid);
          grew = true;
        }
      }
      const closure = materialClosureFromGuids([...needed], (guid) =>
        loaded.get(guid) ?? null,
      );
      const documents = new Map<string, MaterialDocument>();
      const functions = new Map<string, MaterialFunctionDocument>();
      for (const guid of closure.materials) {
        const content = loaded.get(guid);
        if (content) documents.set(guid, normalizeMaterialDocument(content));
      }
      for (const guid of closure.functions) {
        const content = loaded.get(guid);
        if (content) {
          functions.set(guid, normalizeMaterialFunctionDocument(content));
        }
      }
      return { documents, functions, textureGuids: closure.textures };
    },
    [loadPlayAssetContent, projectService],
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
    const paths = playSceneLibraryPaths(
      projectDocument?.scenes ?? [],
      projectService.registry?.list() ?? [],
    );
    const open = documentService.getState().openDocuments;
    const scenes: Array<{ guid: string; scene: SerializedScene }> = [];
    for (const path of paths) {
      const id = documentId({ kind: "scene", path });
      const openDoc = open.get(id);
      try {
        const content =
          openDoc?.content ?? (await projectService.loadDocument("scene", path));
        scenes.push({
          guid: projectService.guidForPath(path) ?? id,
          scene: normalizeScene(content),
        });
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
        setUiDocumentContent: (
          path: string,
          content: Record<string, unknown>,
        ) => Promise<boolean>;
        dispatchPlayUiWidgetEvent: (event: {
          instanceId: string;
          widgetId: string;
          kind: UiWidgetEventKind;
          value?: unknown;
        }) => boolean;
        setMainGraphComponents: (
          components: SerializedGraph["components"],
        ) => Promise<boolean>;
        setActiveSceneContent: (scene: SerializedScene) => Promise<boolean>;
        guidForPath: (path: string) => string | null;
        projectStartupSceneGuid: () => string;
        pluginGuids: () => string[];
        enginePluginLoad: () => {
          entries: number;
          unpacked: number;
          errors: string[];
        };
        assetByGuid: (guid: string) => {
          guid: string;
          type: string;
          path: string;
          placeholder: boolean;
        } | null;
        seedMissingPluginOverride: (guid: string) => Promise<{
          guid: string;
          type: string;
          path: string;
          placeholder: boolean;
        } | null>;
        activeTilemapTile: (gx: number, gy: number) => number | null;
        touchAssetOnDisk: (path: string) => Promise<void>;
        runForegroundRescan: () => Promise<void>;
        materialPreviewCameraRadius: () => number | null;
        documentDirtyTrace: () => { kind: string; id: string; via?: string }[];
        clearDocumentDirtyTrace: () => void;
        saveAllTrace: () => {
          ok: boolean;
          reason: string;
          dirtyBefore: number;
          dirtyAfter: number;
          error?: string;
        } | null;
        dirtyDocuments: () => { kind: string; id: string }[];
        textureEncodeState: (path: string) => {
          compressionState: string | null;
          encodeError: string | null;
          hasPixels: boolean;
        } | null;
      };
      __babylonslateSourceControl?: SourceControlService;
    };
    host.__babylonslateSourceControl = sourceControlRef.current;
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
      setUiDocumentContent: async (
        path: string,
        content: Record<string, unknown>,
      ) => {
        const id = documentId({ kind: "ui", path });
        if (!documentService.getState().openDocuments.has(id)) {
          await documentService.openDocument(
            projectService,
            { kind: "ui", path, label: path.split("/").pop() ?? path },
            null,
            false,
          );
        }
        return applyAssetDocumentChange(id, content);
      },
      dispatchPlayUiWidgetEvent: (event) =>
        dispatchMountedPlayUiWidgetEvent(event),
      setMainGraphComponents: async (components) => {
        const openGraph = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "graph" && entry.content,
        );
        if (!openGraph?.content) return false;
        const graph = structuredClone(openGraph.content as SerializedGraph);
        graph.components = structuredClone(components);
        return applyGraphChange(openGraph.id, graph);
      },
      setActiveSceneContent: async (scene) => {
        const openScene = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.kind === "scene",
        );
        if (!openScene) return false;
        return applySceneChange(openScene.id, structuredClone(scene));
      },
      guidForPath: (path: string) => projectService.guidForPath(path),
      textureEncodeState: (path: string) => {
        const asset = projectService.registry
          ?.list()
          .find((entry) => entry.path === path);
        if (!asset) return null;
        const state = asset.header.payload.compressionState;
        const encodeError = asset.header.payload.encodeError;
        return {
          compressionState: typeof state === "string" ? state : null,
          encodeError: typeof encodeError === "string" ? encodeError : null,
          hasPixels: asset.header.chunks.some(
            (chunk) => chunk.kind === "pixels" || chunk.id === "pixels",
          ),
        };
      },
      projectStartupSceneGuid: () =>
        projectDocument?.settings.startupSceneGuid?.trim() ?? "",
      pluginGuids: () =>
        projectService.plugins.map((plugin) => plugin.pluginGuid),
      enginePluginLoad: () => ({ ...lastEnginePluginLoad }),
      assetByGuid: (guid: string) => {
        const asset = projectService.registry?.getByGuid(guid);
        if (!asset) return null;
        return {
          guid: asset.header.guid,
          type: asset.header.type,
          path: asset.path,
          placeholder: asset.placeholder === true,
        };
      },
      seedMissingPluginOverride: async (guid: string) => {
        const current =
          projectDocumentRef.current?.settings.pluginOverrides ?? {};
        const next = { ...current, [guid]: { enabled: true } };
        updateProjectSettings({ pluginOverrides: next });
        await projectService.applyPluginOverrides(next);
        bump();
        const asset = projectService.registry?.getByGuid(guid);
        if (!asset) return null;
        return {
          guid: asset.header.guid,
          type: asset.header.type,
          path: asset.path,
          placeholder: asset.placeholder === true,
        };
      },
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
      touchAssetOnDisk: async (path: string) => {
        const storage = projectService.storagePort;
        if (!(await storage.exists(path))) return;
        const bytes = await storage.readBinary(path);
        await storage.writeBinary(path, bytes);
      },
      runForegroundRescan: () => runForegroundRescanRef.current(),
      materialPreviewCameraRadius,
      documentDirtyTrace,
      clearDocumentDirtyTrace,
      saveAllTrace,
      dirtyDocuments: () =>
        documentService.getDirtyDocuments().map((doc) => ({
          kind: doc.ref.kind,
          id: doc.id,
        })),
    };
    return () => {
      delete host.__babylonslateTest;
      delete host.__babylonslateSourceControl;
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
    projectDocument,
    updateProjectSettings,
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

  const registerDockviewApi = useCallback((
    id: string,
    api: DockviewApi,
    surface: DockviewSurface = "default",
  ) => {
    const key = dockviewApiKey(id, surface);
    dockviewApisRef.current.set(key, api);
    for (const sub of dockSubscriptionsRef.current.get(key) ?? []) {
      sub.dispose();
    }
    dockSubscriptionsRef.current.delete(key);
    const rememberPlacements = () => {
      if (preFocusLayoutsRef.current.has(id)) return;
      const dock = asDockWindowApi(api);
      const kind = documentService.getDocument(id)?.ref.kind;
      const doc = documentService.getDocument(id);
      const indexed = projectService.registry
        ?.list()
        .find((asset) => asset.path === doc?.ref.path);
      const parentOf = classParentLookup(projectService.registry?.list() ?? []);
      const surfaceMode: UiEditorMode | undefined =
        surface === "logic"
          ? "logic"
          : surface === "designer"
            ? "designer"
            : undefined;
      const animSurfaceMode: AnimEditorMode | undefined =
        surface === "animationObject"
          ? "animationObject"
          : surface === "stateMachine"
            ? "stateMachine"
            : undefined;
      const dockOptions = dockOptionsForIndexed(
        kind ?? "",
        indexed,
        parentOf,
        sourceControlRef.current.enabled,
        surfaceMode,
        animSurfaceMode,
      );
      for (const panel of listDockPanels(dock)) {
        const def = isDockviewDocumentKind(kind)
          ? findWindowDefinition(kind, panel.id, dockOptions)
          : undefined;
        const placement = capturePanelPlacement(dock, panel.id, def);
        if (placement) {
          documentService.setPanelPlacement(id, panel.id, placement);
        }
      }
    };
    dockSubscriptionsRef.current.set(key, [
      api.onDidAddPanel(() => bumpDockWindows()),
      api.onDidRemovePanel(() => bumpDockWindows()),
      api.onDidLayoutChange(rememberPlacements),
    ]);
    rememberPlacements();
    bumpDockWindows();
  }, [bumpDockWindows, documentService, projectService]);

  const activeDockApi = useCallback((): DockviewApi | undefined => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return undefined;
    const doc = documentService.getDocument(activeDocumentId);
    if (!doc) return undefined;
    if (doc.ref.kind === "ui") {
      const mode = uiEditorModeForDocument(
        activeDocumentId,
        uiEditorModes,
        doc,
      );
      return (
        dockviewApisRef.current.get(
          dockviewApiKey(activeDocumentId, dockviewSurfaceForUiMode(mode)),
        ) ?? dockviewApisRef.current.get(activeDocumentId)
      );
    }
    if (doc.ref.kind === "anim-graph") {
      const mode = animEditorModeForDocument(
        activeDocumentId,
        animEditorModes,
        doc,
      );
      return (
        dockviewApisRef.current.get(
          dockviewApiKey(activeDocumentId, dockviewSurfaceForAnimMode(mode)),
        ) ?? dockviewApisRef.current.get(activeDocumentId)
      );
    }
    return dockviewApisRef.current.get(activeDocumentId);
  }, [documentService, uiEditorModes, animEditorModes]);

  const setUiEditorMode = useCallback(
    (id: string, mode: UiEditorMode) => {
      const doc = documentService.getDocument(id);
      const currentMode = uiEditorModeForDocument(id, uiEditorModes, doc);
      if (currentMode !== mode) {
        const snapshot = preFocusLayoutsRef.current.get(id);
        if (snapshot) {
          restorePreFocusSnapshot(id, snapshot, dockviewApisRef.current);
          preFocusLayoutsRef.current.delete(id);
          setFocusedLayoutIds((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      }
      setUiEditorModes((current) =>
        current[id] === mode ? current : { ...current, [id]: mode },
      );
      if (doc?.ref.kind === "ui") {
        const parsed = parseUiDocumentLayout(doc.layout);
        if (parsed.uiEditorMode !== mode) {
          documentService.setLayout(
            id,
            serializeUiDocumentLayout({ ...parsed, uiEditorMode: mode }),
          );
        }
      }
      bumpDockWindows();
    },
    [bumpDockWindows, documentService, uiEditorModes],
  );

  const setAnimEditorMode = useCallback(
    (id: string, mode: AnimEditorMode) => {
      const doc = documentService.getDocument(id);
      const currentMode = animEditorModeForDocument(id, animEditorModes, doc);
      if (currentMode !== mode) {
        const snapshot = preFocusLayoutsRef.current.get(id);
        if (snapshot) {
          restorePreFocusSnapshot(id, snapshot, dockviewApisRef.current);
          preFocusLayoutsRef.current.delete(id);
          setFocusedLayoutIds((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      }
      setAnimEditorModes((current) =>
        current[id] === mode ? current : { ...current, [id]: mode },
      );
      if (doc?.ref.kind === "anim-graph") {
        const parsed = parseAnimDocumentLayout(doc.layout);
        if (parsed.animEditorMode !== mode) {
          documentService.setLayout(
            id,
            serializeAnimDocumentLayout({ ...parsed, animEditorMode: mode }),
          );
        }
      }
      bumpDockWindows();
    },
    [bumpDockWindows, documentService, animEditorModes],
  );

  const activateDockPanel = useCallback((panelId: string) => {
    activeDockApi()?.getPanel(panelId)?.api.setActive();
  }, [activeDockApi]);

  const toggleDockWindow = useCallback((panelId: string) => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = documentService.getDocument(activeDocumentId);
    if (!doc || !isDockviewDocumentKind(doc.ref.kind)) {
      return;
    }
    const api = activeDockApi();
    if (!api) return;
    const indexed = projectService.registry
      ?.list()
      .find((asset) => asset.path === doc.ref.path);
    const parentOf = classParentLookup(projectService.registry?.list() ?? []);
    const dockOptions = dockOptionsForIndexed(
      doc.ref.kind,
      indexed,
      parentOf,
      sourceControlRef.current.enabled,
      doc.ref.kind === "ui"
        ? uiEditorModeForDocument(activeDocumentId, uiEditorModes, doc)
        : undefined,
      doc.ref.kind === "anim-graph"
        ? animEditorModeForDocument(activeDocumentId, animEditorModes, doc)
        : undefined,
    );
    const def = findWindowDefinition(doc.ref.kind, panelId, dockOptions);
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
  }, [activeDockApi, bumpDockWindows, documentService, projectService, uiEditorModes, animEditorModes]);

  const isDockWindowOpen = useCallback((panelId: string) => {
    const api = activeDockApi();
    return api ? isDockWindowOpenOnApi(asDockWindowApi(api), panelId) : false;
  }, [activeDockApi]);

  const getOpenDockWindowCount = useCallback(() => {
    const api = activeDockApi();
    return api ? listDockPanels(asDockWindowApi(api)).length : 0;
  }, [activeDockApi]);

  const toggleLayoutFocus = useCallback(async () => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = documentService
      .getOpenDocumentsOrdered()
      .find((entry) => entry.id === activeDocumentId);
    if (!doc || !isDockviewDocumentKind(doc.ref.kind)) {
      return;
    }
    const api = activeDockApi();
    if (!api) return;

    if (preFocusLayoutsRef.current.has(activeDocumentId)) {
      const snapshot = preFocusLayoutsRef.current.get(activeDocumentId);
      preFocusLayoutsRef.current.delete(activeDocumentId);
      if (snapshot) {
        restorePreFocusSnapshot(
          activeDocumentId,
          snapshot,
          dockviewApisRef.current,
        );
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
    const dock = api;
    const indexed = projectService.registry
      ?.list()
      .find((asset) => asset.path === doc.ref.path);
    const parentOf = classParentLookup(projectService.registry?.list() ?? []);
    const uiMode =
      doc.ref.kind === "ui"
        ? uiEditorModeForDocument(activeDocumentId, uiEditorModes, doc)
        : undefined;
    const animMode =
      doc.ref.kind === "anim-graph"
        ? animEditorModeForDocument(activeDocumentId, animEditorModes, doc)
        : undefined;
    const dockOptions = dockOptionsForIndexed(
      doc.ref.kind,
      indexed,
      parentOf,
      sourceControlRef.current.enabled,
      uiMode,
      animMode,
    );

    preFocusLayoutsRef.current.set(activeDocumentId, {
      layout: dock.toJSON() as unknown as Record<string, unknown>,
      surface: uiMode
        ? dockviewSurfaceForUiMode(uiMode)
        : animMode
          ? dockviewSurfaceForAnimMode(animMode)
          : "default",
    });
    applyFocusLayout(
      doc.ref.kind,
      dock,
      focusKeepPanelIds(settings, doc.ref.kind, dockOptions),
      dockOptions,
    );
    setFocusedLayoutIds((current) => {
      const next = new Set(current);
      next.add(activeDocumentId);
      return next;
    });
  }, [activeDockApi, documentService, projectService, settingsStore, uiEditorModes, animEditorModes]);

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
      void sourceControlTick;
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
      exportGameArtifact,
      zipExportedGame,
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
      writeAudioClipChunk,
      removeAudioClipChunk,
      writeSceneNavmeshChunk,
      writeSceneAudioReverbChunk,
      updateProjectSettings,
      sourceControl: sourceControlRef.current,
      prefillSourceControlFromGit,
      externalChangePrompt,
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
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
      uiEditorMode: (() => {
        const activeId = documentService.getState().activeDocumentId;
        if (!activeId) return "designer" as const;
        return uiEditorModeForDocument(
          activeId,
          uiEditorModes,
          documentService.getDocument(activeId),
        );
      })(),
      setUiEditorMode,
      animEditorMode: (() => {
        const activeId = documentService.getState().activeDocumentId;
        if (!activeId) return "stateMachine" as const;
        return animEditorModeForDocument(
          activeId,
          animEditorModes,
          documentService.getDocument(activeId),
        );
      })(),
      setAnimEditorMode,
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
      pluginDescriptors: projectService.plugins,
      pluginDiagnostics: projectService.pluginGraphDiagnostics,
      showPluginContent:
        documentService.getState().showPluginContent === true,
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin,
      deleteProjectPlugin,
      exportPlugin,
      importPlugin,
      repathDocument,
      retryFailedTextureEncoding,
      retryTextureEncoding,
      onSessionDiagnostic,
      sessionDiagnostics: projectService.sessionDiagnostics,
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
      collectPlaySpriteAnimationPayloads,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayModelBytes,
      collectPlayAudio,
      collectPlayParticles,
      collectPlayMaterialLibrary,
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
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin,
      deleteProjectPlugin,
      exportPlugin,
      importPlugin,
      repathDocument,
      retryFailedTextureEncoding,
      retryTextureEncoding,
      onSessionDiagnostic,
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
      collectPlaySpriteAnimationPayloads,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayModelBytes,
      collectPlayAudio,
      collectPlayParticles,
      collectPlayMaterialLibrary,
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
      exportGameArtifact,
      zipExportedGame,
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
      writeAudioClipChunk,
      removeAudioClipChunk,
      writeSceneNavmeshChunk,
      writeSceneAudioReverbChunk,
      updateProjectSettings,
      prefillSourceControlFromGit,
      sourceControlTick,
      externalChangePrompt,
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
      undoActiveDocument,
      redoActiveDocument,
      registerDockviewApi,
      setUiEditorMode,
      uiEditorModes,
      setAnimEditorMode,
      animEditorModes,
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
