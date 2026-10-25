import type { DockviewApi } from "dockview-react";
import type {
  AssetDocumentKind,
  DocumentRef,
  InputAssetDefinition,
  PluginEnableOverride,
  ProjectDocument,
  ProjectFolderHandle,
  RenderTargetPayload,
  RenderTargetTexturePayload,
  Result,
  SerializedGraph,
  SerializedScene,
  WaterDefinition,
} from "@haptic/core";
import type {
  AssetLoadPriority,
  AssetLoadScope,
  AssetLoadState,
  AssetRegistry,
  ClassAssetReplacement,
  ExternalChangeClassification,
  MigrationPending,
  PluginDescriptor,
  PluginDiagnostic,
  ProjectSearchIndex,
  ProjectTemplateCatalogEntry,
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
  TraceDocumentEntry,
} from "@haptic/assets";
import type { ScriptBundleEntry } from "@haptic/bridge";
import type { TracePayload } from "@haptic/debugger";
import type { ExportArtifact } from "@haptic/exporter";
import type { Diagnostic } from "@haptic/scripting";
import type { MaterialDocument, MaterialFunctionDocument } from "@haptic/shader-graph";
import type { GitConfigPrefill } from "@haptic/source-control";
import type { CreateProjectOptions } from "../lib/create-project";
import type { ListedProject, UpdateListedProjectOptions } from "../lib/listed-projects";
import type { AssetThumbnailWriteIdentity } from "../lib/asset-thumbnail-revision";
import type { DocumentService, DocumentIdentityListener, DocumentRevisions, OpenDocument } from "../services/document-service";
import type { DocumentTransitionGate } from "../services/document-transition-gate";
import type { PlayScriptCompileOptions } from "../services/play-content-service";
import type { PluginImportResult, ProjectService } from "../services/project-service";
import type { SimulationDocumentTransaction } from "../services/simulation-document";
import type { SourceControlService } from "../services/source-control-service";
import type { AnimEditorMode } from "../shell/anim-document-layout";
import type { DockviewSurface } from "../shell/dockview-surface";
import type { SceneMode } from "../shell/scene-document-layout";


export type AppRoute = "home" | "editor";

/**
 * `closeProject`: closed, held by unsaved work (nothing was written; a
 * session was stopped only when its stop left that work, as Simulation's Keep
 * Changes does), or refused by a running Play / Simulate session.
 */
export type CloseProjectResult =
  | { outcome: "closed" }
  | { outcome: "unsaved"; dirty: OpenDocument[]; projectDirty: boolean }
  | { outcome: "refused" };

export interface DocumentContextValue {
  registerBeforeTransition: DocumentTransitionGate["register"];
  /** Protect in-memory authoring; the owner must release its lease on every exit. */
  lockAuthoring: DocumentService["lockAuthoring"];
  beginSimulationDocument: (id: string) => SimulationDocumentTransaction;
  getAuthoringLock: DocumentService["getAuthoringLock"];
  subscribeAuthoringLock: DocumentService["onAuthoringLockChange"];
  lockAuthoringWrites: ProjectService["lockAuthoringWrites"];
  withSceneWrite: ProjectService["withSceneWrite"];
  route: AppRoute;
  projectDocument: ProjectDocument | null;
  projectName: string | null;
  assetRegistry: AssetRegistry | null;
  extensionService: ProjectService["extensions"];
  projectGuid: string | null;
  /**
   * Registry epoch: changes only when what `assetRegistry` reports changes
   * (its generation: imports, saves, deletes, moves, encodes, remounts) or a
   * registry-adjacent ProjectService change arrives (plugins, search index,
   * Show Plugin Content). Document edits, tab changes, saves' dirty-state
   * changes and other per-edit context updates leave it alone, so key
   * registry-derived memos and effects on it instead of on the context value.
   * Monotonic; never repeats.
   */
  registryEpoch: number;
  /**
   * Textures whose encode is running. The file stays `pending` until the
   * encode commits, so this memory-only set is the only record that it started
   * (`shownCompressionState`). A new set at each change, which also advances
   * `registryEpoch`.
   */
  encodingTextures: ReadonlySet<string>;
  refreshAssetRegistry: () => Promise<void>;
  /**
   * Re-reads the project's scene/graph lists and re-renders after assets were
   * created through the mounted registry, which indexes them on write. Much
   * cheaper than `refreshAssetRegistry`, which remounts and rescans every root.
   */
  noteAssetsCreated: () => void;
  pluginDescriptors: PluginDescriptor[];
  pluginDiagnostics: PluginDiagnostic[];
  showPluginContent: boolean;
  setShowPluginContent: (show: boolean) => void;
  applyPluginOverrides: (
    overrides: Record<string, PluginEnableOverride>,
  ) => Promise<void>;
  createProjectPlugin: (displayName: string) => Promise<PluginDescriptor>;
  deleteProjectPlugin: (guid: string) => Promise<void>;
  exportPlugin: (guid: string) => Promise<Uint8Array>;
  importPlugin: (
    bytes: Uint8Array,
    decision?: "keep" | "replace",
  ) => Promise<PluginImportResult>;
  /**
   * Retarget open tabs after a file move or rename. Undo history, dock Focus
   * state, Anim mode and session view state follow the document to its new id.
   */
  repathDocument: (
    kind: AssetDocumentKind,
    oldPath: string,
    newPath: string,
  ) => void;
  /**
   * Follow a Content Browser folder rename or move in the project settings
   * that name folders (Always Package Folders).
   */
  repathProjectFolder: (fromFolder: string, toFolder: string) => void;
  renameAsset: ProjectService["renameAsset"];
  /** Document opens and renames, for session state keyed by document id. */
  subscribeDocumentIdentity: (listener: DocumentIdentityListener) => () => void;
  /**
   * A file of a project's editor state in app-private derived storage (outside the project folder,
   * never exported), or null when there is none.
   */
  readProjectDerivedText: (projectGuid: string, name: string) => Promise<string | null>;
  /** Writes a file of a project's editor state in derived storage. */
  writeProjectDerivedText: (projectGuid: string, name: string, text: string) => Promise<void>;
  retryFailedTextureEncoding: () => Promise<number>;
  prepareAreaEmission: ProjectService["prepareAreaEmission"];
  /** Converts an environment Texture's kept `.hdr` again at another Face Size; false when nothing was written. */
  reconvertHdrEnvironment: ProjectService["reconvertHdrEnvironment"];
  collectPlayAreaEmissions: (scenes: readonly (SerializedScene | null | undefined)[], includeGraphs?: boolean) => Promise<Map<string, import("@haptic/assets").AreaEmissionPixels>>;
  retryTextureEncoding: (
    guid: string,
    options?: { maxDimension?: number; force?: boolean; usage?: string },
  ) => Promise<boolean>;
  /**
   * A `compressed` Texture whose committed encode the alignment policy would
   * change and nothing re-encodes yet: Texture Details offers Retry Encoding.
   */
  textureAlignmentStale: ProjectService["textureAlignmentStale"];
  /**
   * Why an edit or re-encode from outside the Texture tab cannot write this
   * Texture, as a sentence (a read-only root or plugin, or another user's
   * lock); null when it can. Reads live lock and tab state, so call it while
   * rendering.
   */
  textureUsageBlockedReason: (guid: string) => string | null;
  onSessionDiagnostic: (listener: (line: string) => void) => () => void;
  /**
   * Canonical open documents in tab order, including background working
   * documents used by utilities. Navigation omits `background`.
   * The array keeps its identity until a
   * document revision advances or the tab order changes, so registry-only
   * updates, tab switches and other context updates leave it alone. Its
   * entries are mutated in place (content, dirty, layout), so entry identity
   * is not a change signal: key memos on `documentRevisions`.
   */
  openDocuments: OpenDocument[];
  /**
   * The open documents at call time, read from the document service. Stable
   * identity: handlers, guards and async continuations use it instead of a
   * render-time `openDocuments` snapshot, so they stay correct without
   * re-rendering on every edit.
   */
  getOpenDocuments: () => OpenDocument[];
  /**
   * One revision per document kind, advanced when a document of that kind
   * opens, closes, moves, is reordered, edited (including Undo / Redo,
   * reloads and patches), relaid out or changes dirty state. Memos that read
   * other documents key on the kinds they read (`documentKindsRevision`,
   * `useOpenDocumentsOfKinds`) instead of on `openDocuments`.
   */
  documentRevisions: DocumentRevisions;
  /** Advances when the open set, the tab order or the active tab changes. */
  tabsRevision: number;
  /** Keeps its identity while the tab ids and their order are unchanged. */
  tabOrder: string[];
  activeDocumentId: string | null;
  listedProjects: ListedProject[];
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  /** Recomputed only when a document revision advances. */
  dirtyDocuments: OpenDocument[];
  projectDirty: boolean;
  autoSaveStatus: { state: "saving" | "saved" | "error"; message?: string } | null;
  migrationPending: MigrationPending[];
  /** Advances each time a Save All the user asked for is refused for pending migrations. */
  migrationPromptRequest: number;
  templates: ProjectTemplateCatalogEntry[];
  homepageReady: boolean;
  refreshTemplates: () => Promise<void>;
  openProject: (source?: "folder" | "zip") => Promise<void>;
  createEmptyProject: (
    name: string,
    options?: CreateProjectOptions,
  ) => Promise<void>;
  createFromTemplate: (
    templateId: string,
    name: string,
    options?: CreateProjectOptions,
  ) => Promise<void>;
  openListedProject: (handle: ProjectFolderHandle) => Promise<void>;
  updateListedProject: (
    handle: ProjectFolderHandle,
    details: UpdateListedProjectOptions,
  ) => Promise<void>;
  removeListedProject: (handle: ProjectFolderHandle) => Promise<void>;
  reconnectProject: () => Promise<void>;
  saveProject: () => Promise<boolean>;
  /**
   * Hold the auto-save timer while a prompt lists unsaved work, so the choice
   * it asks for applies to that work. Resuming starts a new interval when
   * something is still unsaved.
   */
  setAutoSavePaused: (paused: boolean) => void;
  saveAll: () => Promise<boolean>;
  /** Approve pending schema migrations and run the complete Save All; false when it did not save. */
  approveMigrationsAndSave: () => Promise<boolean>;
  /** Closes a clean project; unsaved work returns it without asking a session to stop. */
  closeProject: () => Promise<CloseProjectResult>;
  /**
   * Ask a running Play or Simulate session to stop before the close prompt's
   * Save All, whose writes the session's authoring lock refuses.
   */
  releaseSessionsForProjectClose: () => Promise<boolean>;
  /** Close without saving once sessions stop and queued writes finish; false when a session refused. */
  forceCloseProject: () => Promise<boolean>;
  exportProject: (snapshot?: ProjectDocument) => Promise<Uint8Array>;
  exportGameArtifact: (options?: {
    projectSnapshot?: ProjectDocument;
    previewBuild?: boolean;
    playerFiles?: Map<string, Uint8Array>;
    onPhase?: (phase: "Compiling" | "Writing Pack") => void;
    startupSceneGuid?: string | null;
    transcoderAvailable?: boolean;
  }) => Promise<Result<ExportArtifact, string>>;
  zipExportedGame: (artifact: ExportArtifact) => Uint8Array;
  dismissRecovery: () => Promise<void>;
  keepRecovery: () => void;
  openDocument: (ref: DocumentRef) => Promise<void>;
  /** Loads a canonical working document without creating or activating a tab. */
  ensureAssetDocument: (ref: DocumentRef) => Promise<string>;
  /**
   * Spill a finished Play recorder payload and open the read-only Trace tab. With `keep`, older traces
   * beyond that many are then deleted, except ones open in a tab.
   */
  openRecordedTrace: (payload: TracePayload, options?: { keep?: number }) => Promise<void>;
  /** The project's recorded traces, newest first. */
  listRecentTraces: () => Promise<TraceDocumentEntry[]>;
  /** Open a recorded trace again in a read-only Trace tab. */
  openTraceDocument: (path: string) => Promise<void>;
  pendingExclusiveScene: DocumentRef | null;
  confirmExclusiveSceneOpen: (mode: "save" | "discard") => Promise<void>;
  cancelExclusiveSceneOpen: () => void;
  closeDocument: (id: string) => void;
  closeDocumentsForPaths: (paths: Iterable<string>) => void;
  replaceClassReferencesBeforeDelete: (
    replacements: readonly ClassAssetReplacement[],
    deletingGuids: ReadonlySet<string>,
    onProgress?: (currentName: string) => Promise<void>,
  ) => Promise<void>;
  repairAfterAssetDelete: (
    deletedGuids: ReadonlySet<string>,
    deletedClassNames?: ReadonlySet<string>,
    onProgress?: (currentName: string) => Promise<void>,
    /** Storage folders the operation deleted. */
    deletedFolders?: readonly string[],
  ) => Promise<void>;
  setActiveDocument: (id: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  reorderClosableTabs: (fromIndex: number, toIndex: number) => void;
  /** Apply a graph edit through the command layer (marks dirty + undoable). */
  applyGraphChange: (id: string, next: SerializedGraph) => Promise<boolean>;
  /**
   * Change Class `header.parentClass` without rewriting the graph payload.
   * Returns an error string when the reparent is rejected.
   */
  reparentClassDocument: (
    id: string,
    newParentId: string,
  ) => Promise<string | null>;
  /** Apply a scene edit through the command layer (marks dirty + undoable). */
  applySceneChange: (
    id: string,
    next: SerializedScene,
    options?: { prefabSync?: boolean },
  ) => Promise<boolean>;
  applyAssetDocumentChange: (
    id: string,
    next: Record<string, unknown>,
    mergeKey?: string,
  ) => Promise<boolean>;
  /** Scene, runtime object, and explicit preload ownership. */
  createAssetLoadScope: (owner: string) => AssetLoadScope;
  getAssetLoadState: (guid: string) => AssetLoadState;
  /** Font source / other binary chunks. */
  readAssetChunk: (path: string, chunkId: string, options?: { ownerDocumentId?: string; scope?: AssetLoadScope; signal?: AbortSignal; priority?: AssetLoadPriority }) => Promise<Uint8Array | null>;
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
  updateProjectVersion: (version: string) => void;
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
  /**
   * Set when an edit was larger than the Undo memory limit: it applied, but
   * its document's Undo history was cleared. Once per gesture; `sequence`
   * advances for each new notice.
   */
  undoHistoryNotice: { documentId: string; sequence: number } | null;
  dismissUndoHistoryNotice: () => void;
  registerDockviewApi: (
    id: string,
    api: DockviewApi,
    surface?: DockviewSurface,
  ) => void;
  unregisterDockviewApi: (id: string, surface?: DockviewSurface) => void;
  captureLayoutForId: (id: string) => void;
  animEditorMode: AnimEditorMode;
  setAnimEditorMode: (id: string, mode: AnimEditorMode) => void;
  sceneMode: SceneMode;
  setSceneMode: (id: string, mode: SceneMode) => void;
  activateDockPanel: (panelId: string) => void;
  toggleDockWindow: (panelId: string) => void;
  isDockWindowOpen: (panelId: string) => boolean;
  getOpenDockWindowCount: () => number;
  isLayoutFocused: boolean;
  toggleLayoutFocus: () => void;
  /** Lazy CB thumbnail decode (derived-data LRU, separate from scene cache). */
  loadAssetThumbnail: (assetGuid: string) => Promise<Uint8Array | null>;
  writeAssetThumbnail: (assetGuid: string, bytes: Uint8Array, expected?: AssetThumbnailWriteIdentity) => Promise<void>;
  thumbnailVersions: Readonly<Record<string, number>>;
  thumbnailsEnabled: boolean;
  /** Compile requested Play graphs, or every graph for explicit project compilation. */
  collectPlayPreviewScripts: (requiredGuids?: ReadonlySet<string>, sourceDocuments?: readonly OpenDocument[], sourceProject?: ProjectDocument, compileOptions?: PlayScriptCompileOptions) => Promise<{
    bundles: ScriptBundleEntry[];
    diagnostics: Diagnostic[];
  }>;
  collectEditorUtilityScripts: () => Promise<ScriptBundleEntry[]>;
  loadAssetDocument: (
    kind: AssetDocumentKind,
    path: string,
  ) => Promise<unknown | null>;
  /** Sprite payloads referenced by the Play scene for clip UV seeks. */
  collectPlaySpritePayloads: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
  ) => Promise<Map<string, SpritePayload>>;
  collectPlayWaterContent: (requiredGuids?: ReadonlySet<string>) => Promise<Map<string, WaterDefinition>>;
  collectPlayRenderTargets: (requiredGuids?: ReadonlySet<string>) => Promise<{ renderTargets: Map<string, RenderTargetPayload>; renderTargetTextures: Map<string, RenderTargetTexturePayload> }>;
  collectPlayTilemapContent: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
  ) => Promise<{
    tilemaps: Map<string, TilemapPayload>;
    tilesets: Map<string, TilesetPayload>;
  }>;
  /** GPU texture bytes (KTX2 or LOD-downsampled source) for sprite, tileset, and material `textureGuid`s. */
  collectPlayTextureBytes: (
    sprites: ReadonlyMap<string, SpritePayload>,
    tilesets: ReadonlyMap<string, TilesetPayload>,
    extraGuids?: readonly string[],
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
    includeMaterialParameterTextures?: boolean,
  ) => Promise<Map<string, Uint8Array>>;
  /** Authored Texture payload pixels for overlay 2DTexture world size. */
  collectPlayTexturePixelSizes: (
    sprites: ReadonlyMap<string, SpritePayload>,
    tilesets: ReadonlyMap<string, TilesetPayload>,
    extraGuids?: readonly string[],
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
  ) => Map<string, { width: number; height: number }>;
  /** Facetype JSON bytes for Text3DComponent Font references. */
  collectPlayFontFacetypeBytes: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
  ) => Promise<Map<string, Uint8Array>>;
  /** MSDF JSON + PNG pairs for overlay 2D Text. */
  collectPlayFontMsdfPair: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
  ) => Promise<Map<string, { json: Uint8Array; png: Uint8Array }>>;
  /** FontFace source bytes for Bitmap 2D Text. */
  collectPlayFontFaceEntries: (requiredGuids?: ReadonlySet<string>) => Promise<
    import("@haptic/render").FontAssetEntry[]
  >;
  /** Compiled CSS stacks for Bitmap overlay 2D Text. */
  collectPlayFontCssStacks: () => {
    fontCssStack: string;
    fontCssStackByGuid: Map<string, string>;
  };
  /** Model source bytes for scene MeshComponent `assetGuid`s. */
  collectPlayModelBytes: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
    requiredGuids?: ReadonlySet<string>,
  ) => Promise<Map<string, Uint8Array>>;
  /** Model material slots for Play and the editor viewport. */
  collectPlayModelPayloads: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
  ) => Promise<Map<string, import("@haptic/assets").ModelPayload>>;
  /** Mixer/channel/attenuation/Audio metadata for Play; source bytes load on first playSound. */
  collectPlayInputAssets: (requiredGuids?: ReadonlySet<string>) => Promise<InputAssetDefinition[]>;
  collectPlayAudio: (requiredGuids?: ReadonlySet<string>) => Promise<{
    library: import("../lib/play-audio").PlayAudioLibrary;
    loadSourceBytes: import("../lib/play-audio").PlayAudioSourceLoader;
  }>;
  /** Surface, post-process, and particle materials plus transitive Material Functions. */
  collectPlayMaterialLibrary: (
    scene?: SerializedScene | null,
    extraScenes?: readonly SerializedScene[],
    extraMaterialGuids?: readonly string[],
  ) => Promise<{
    documents: Map<string, MaterialDocument>;
    functions: Map<string, MaterialFunctionDocument>;
    textureGuids: string[];
  }>;
  /** Class graph payload from an open tab or disk. */
  loadGraphDocument: (path: string) => Promise<SerializedGraph | null>;
  /**
   * True when Play's stored full-project bundles do not match the current
   * open-graph fingerprint (or Play has not collected this session).
   * Distinct from `graphsNeedCompile` / editor Compile.
   */
  scriptsStale: boolean;
  /** True when Compile should run: never compiled this session, or open graphs changed. */
  graphsNeedCompile: boolean;
  /**
   * Open-graph compile fingerprint (node positions omitted). Recomputed only
   * when Class graph or Input Action / Axis documents change, or the registry
   * epoch advances.
   */
  currentGraphSignature: string;
  /** Last full-project bundles written by an explicit toolbar Compile. */
  playPreviewBundles: ScriptBundleEntry[];
  playPreviewDiagnostics: Diagnostic[];
  playLoadedSignature: string | null;
  /** Project-wide search index (headers + Scene/Graph documents). */
  searchIndex: ProjectSearchIndex | null;
}

type DocumentActionName = {
  [K in keyof DocumentContextValue]: DocumentContextValue[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof DocumentContextValue];

/**
 * Every callback of the document context. Each keeps its identity for the
 * provider's lifetime and reads documents, the project, Anim modes and other
 * provider state when it runs. A component that calls one while rendering
 * (`isDockWindowOpen`, `textureUsageBlockedReason`, …) and shows the result
 * must also subscribe to the state it depends on through a narrow hook (or
 * `useDocuments()`).
 */
export type DocumentActions = Pick<DocumentContextValue, DocumentActionName>;

/*
 * Narrow slices of the document context. Each object keeps its identity until
 * one of its fields changes, so its readers re-render only for that state.
 * Field names match `useDocuments()`, so a component moves to a slice by
 * changing only the hook it calls.
 */

/** `useProjectState()`: changes when the project document is replaced. */
export type ProjectState = Pick<DocumentContextValue, "projectDocument" | "projectName">;
/**
 * `useRegistryState()`: the asset registry and the registry-adjacent state
 * that advances `registryEpoch`. Document edits and tab changes leave it.
 */
export type RegistryState = Pick<
  DocumentContextValue,
  | "assetRegistry"
  | "registryEpoch"
  | "encodingTextures"
  | "projectGuid"
  | "extensionService"
  | "pluginDescriptors"
  | "pluginDiagnostics"
  | "showPluginContent"
  | "searchIndex"
>;
/** `useActiveDocumentState()`: the active tab and its chrome state. */
export type ActiveDocumentState = Pick<
  DocumentContextValue,
  | "activeDocumentId"
  | "animEditorMode"
  | "sceneMode"
  | "isLayoutFocused"
  | "canUndoActiveDocument"
  | "canRedoActiveDocument"
>;
/**
 * `useSaveState()`: unsaved work, edits still waiting for Recover or Discard,
 * and Auto-Save. `dirtyDocuments` keeps its identity while the same documents
 * (with the same labels) are dirty, so further edits of an already dirty
 * document do not change it.
 */
export type SaveState = Pick<DocumentContextValue, "dirtyDocuments" | "projectDirty" | "autoSaveStatus" | "recoveryAvailable">;
/** `useCompileState()`: compile staleness and the Play preview bundles. */
export type CompileState = Pick<
  DocumentContextValue,
  | "graphsNeedCompile"
  | "scriptsStale"
  | "currentGraphSignature"
  | "playPreviewBundles"
  | "playPreviewDiagnostics"
  | "playLoadedSignature"
>;
/** `useEditorShellState()`: Homepage, recovery, prompts and thumbnails. */
export type EditorShellState = Pick<
  DocumentContextValue,
  | "listedProjects"
  | "needsReconnect"
  | "recoveryAvailable"
  | "migrationPending"
  | "migrationPromptRequest"
  | "templates"
  | "homepageReady"
  | "pendingExclusiveScene"
  | "externalChangePrompt"
  | "undoHistoryNotice"
  | "thumbnailVersions"
  | "thumbnailsEnabled"
>;
/** `useSourceControl()`: a new object whenever source control state changes. */
export type SourceControlState = Pick<DocumentContextValue, "sourceControl">;

