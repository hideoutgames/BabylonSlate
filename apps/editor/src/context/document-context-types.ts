import type { DockviewApi } from "dockview-react";
import type {
  AssetDocumentKind,
  BuildPlatform,
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
  StorageTier,
  WaterDefinition,
} from "@haptic/core";
import type {
  AssetLoadPriority,
  AssetLoadScope,
  AssetLoadScopeOptions,
  AssetLoadState,
  AssetRegistry,
  ClassAssetReplacement,
  ExternalChangeClassification,
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
import type { ThumbnailVersions } from "@haptic/editor-kit";
import type { TracePayload } from "@haptic/debugger";
import type { ExportArtifact } from "@haptic/exporter";
import type { Diagnostic } from "@haptic/scripting";
import type { MaterialDocument, MaterialFunctionDocument } from "@haptic/shader-graph";
import type { GitConfigPrefill } from "@haptic/source-control";
import type { CreateProjectOptions } from "../lib/create-project";
import type { ListedProject, UpdateListedProjectOptions } from "../lib/listed-projects";
import type { AssetThumbnailWriteIdentity } from "../lib/asset-thumbnail-revision";
import type { DocumentAuthoringLock, DocumentService, DocumentIdentityListener, OpenDocument } from "../services/document-service";
import type { DocumentTransitionGate } from "../services/document-transition-gate";
import type { PlayScriptCompileOptions } from "../services/play-content-service";
import type { BlobReclaimResult, PluginImportOptions, PluginImportResult, ProjectService } from "../services/project-service";
import type { SimulationDocumentTransaction } from "../services/simulation-document";
import type { SourceControlService } from "../services/source-control-service";
import type { SourceControlSyncService, TransferMonitor } from "../services/source-control-sync";
import type { NewRepositoryRequest, PublishOutcome } from "../services/source-control-publish";

/**
 * An editor operation's read-only lock on the documents (`lockAuthoring`) and
 * the lock state it saw right after taking it: work done for that operation
 * may still change documents while the lock state is exactly this one.
 */
export interface AuthoringHold {
  readonly lock: DocumentAuthoringLock;
  release(): void;
}

export interface CloneProjectRequest {
  repositoryUrl: string;
  branch: string;
  /** The new project's name; its folder in app storage is named after it. */
  name: string;
}

export interface PublishSummary {
  assets: number;
  bytes: number;
  /** Bytes in `.blobs` files, which go through Git LFS. */
  lfsBytes: number;
}
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

/**
 * How a Save All ended. `saved` wrote everything; `locked` wrote everything
 * except documents someone else holds a source control lock on, which stay
 * unsaved. Nothing was written for `authoring-locked` (Play or a Simulation
 * holds the project), `recovery-pending` (the recovery choice is still open:
 * a save now would move the saved base the recovered edits replay onto) or
 * `no-document` (no project is open).
 */
export type SaveAllOutcome = "saved" | "locked" | "authoring-locked" | "recovery-pending" | "no-document";

/** What a Save All the user asked for was for: Play and Preview Build cannot start while documents stay unsaved. */
export type SaveFailedPurpose = "save" | "play" | "preview";

/** `recoveryNotice`: documents changed since the project opened (by label), or a journal that could not be read. */
export type RecoveryNotice = { kind: "changed"; documents: string[] } | { kind: "unreadable" };

/** The documents a Save All left unsaved because someone else has locked them, each with its lock's holder. */
export interface SaveFailed {
  documents: readonly { id: string; path: string; label: string; holder: string }[];
  purpose: SaveFailedPurpose;
}

/**
 * Everything `DocumentProvider` publishes, by field: `DocumentActions` picks
 * its callbacks and each state slice below its fields. Open documents are
 * read through the subscription hooks (`useOpenDocument`,
 * `useOpenDocumentsOfKinds`, `useOpenDocumentTabs`, `useTabOrder`) or
 * `getOpenDocuments()`.
 */
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
   * registry-derived memos and effects on it.
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
  /** Returns `executeJavaScript` without writing unless `options.allowExecuteJavaScript` confirms the plugin's Execute JavaScript. */
  importPlugin: (
    bytes: Uint8Array,
    decision?: "keep" | "replace",
    options?: PluginImportOptions,
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
  /** Project Settings' Clean Unused Project Storage, as the project's only writer (`ProjectService.reclaimUnusedBlobs`). */
  reclaimUnusedProjectStorage: () => Promise<BlobReclaimResult>;
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
   * Canonical open documents in tab order at call time, including background
   * working documents used by utilities (navigation omits `background`), read
   * from the document service. Stable identity: handlers, guards and async
   * continuations call it, so they stay correct without re-rendering on every
   * edit. Entries are mutated in place (content, dirty, layout); a component
   * that shows open documents subscribes through `useOpenDocument`,
   * `useOpenDocumentsOfKinds` or `useOpenDocumentTabs`.
   */
  getOpenDocuments: () => OpenDocument[];
  activeDocumentId: string | null;
  listedProjects: ListedProject[];
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  /**
   * What the recovery prompt must say besides its offer: Recover found
   * documents edited or saved since the project opened (`changed`, nothing
   * replayed yet), or the last session's records could not be read when the
   * project opened (`unreadable`, they were discarded).
   */
  recoveryNotice: RecoveryNotice | null;
  /**
   * Crash recovery stopped recording edits (storage stayed full, or too many
   * records failed to write): a crash now loses the edits since, until a Save
   * All leaves nothing unsaved.
   */
  journalPaused: boolean;
  /** Open documents with unsaved edits. */
  dirtyDocuments: OpenDocument[];
  projectDirty: boolean;
  autoSaveStatus: { state: "saving" | "saved" | "error"; message?: string } | null;
  /** Documents a Save All the user asked for left unsaved because someone else has locked them. */
  saveFailed: SaveFailed | null;
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
  /** Auto-Save's Save All: documents someone else has locked stay unsaved quietly, and nothing prompts. */
  saveProject: () => Promise<SaveAllOutcome>;
  /**
   * Hold the auto-save timer while a prompt lists unsaved work, so the choice
   * it asks for applies to that work. Resuming starts a new interval when
   * something is still unsaved.
   */
  setAutoSavePaused: (paused: boolean) => void;
  /**
   * The Save All the user asked for (`purpose` names what for in Save
   * Failed): documents someone else has locked are listed in Save Failed.
   */
  saveAll: (purpose?: SaveFailedPurpose) => Promise<SaveAllOutcome>;
  /** Save Failed's **Ignore**: the documents stay unsaved in the editor. */
  dismissSaveFailed: () => void;
  /**
   * Save Failed's **Discard Changes**: reloads the open documents of `paths`
   * from disk, dropping their unsaved edits, Undo history and recovery
   * records. False when it could not now: documents are read-only (Play,
   * Simulation, a pull) or a file could not be read.
   */
  discardDocumentChanges: (paths: string[]) => Promise<boolean>;
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
  exportGameArtifact: (options: {
    /** The platform the game is packaged for; Preview Build packs the web game. */
    platform: BuildPlatform;
    projectSnapshot?: ProjectDocument;
    previewBuild?: boolean;
    playerFiles?: Map<string, Uint8Array>;
    onPhase?: (phase: "Compiling" | "Writing Pack") => void;
    startupSceneGuid?: string | null;
    transcoderAvailable?: boolean;
  }) => Promise<Result<ExportArtifact, string>>;
  zipExportedGame: (artifact: ExportArtifact) => Promise<Uint8Array>;
  dismissRecovery: () => Promise<void>;
  /**
   * Recover Edits. With `replaceChanged` it goes ahead over documents edited
   * or saved since the project opened, after the user confirmed
   * (`recoveryNotice` `changed`).
   */
  keepRecovery: (options?: { replaceChanged?: boolean }) => void;
  /** Closes `recoveryNotice` (its Cancel or OK). */
  dismissRecoveryNotice: () => void;
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
  /** Opens or activates a transient tab (a Text Editor tab: no asset, never saved or restored). Returns its id. */
  openTransientDocument: (ref: DocumentRef, setActive?: boolean) => string;
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
  /**
   * Apply a scene edit through the command layer (marks dirty + undoable);
   * an edit with `mergeKey` joins the latest Undo step of the same key.
   */
  applySceneChange: (
    id: string,
    next: SerializedScene,
    options?: { prefabSync?: boolean; mergeKey?: string },
  ) => Promise<boolean>;
  applyAssetDocumentChange: (
    id: string,
    next: Record<string, unknown>,
    mergeKey?: string,
  ) => Promise<boolean>;
  /** Scene, runtime object, and explicit preload ownership; `keep` holds what it released past the short retention (Play). */
  createAssetLoadScope: (owner: string, options?: AssetLoadScopeOptions) => AssetLoadScope;
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
  /** Integrated mode's Git sync; one instance for the provider's lifetime, read through `useIntegratedSync()`. */
  sourceControlSync: SourceControlSyncService;
  prefillSourceControlFromGit: () => Promise<GitConfigPrefill>;
  /** The open project's folder for the source control mode rules: its storage tier and whether it has a readable `.git`. */
  readSourceControlFolder: () => Promise<{ tier: StorageTier | null; hasGit: boolean }>;
  /**
   * Clone: the repository's branch into a new project in app storage, with
   * Integrated mode and the repository and branch filled in; open the
   * returned folder as a listed project. `transfer` reports bytes; `signal`
   * cancels, which removes the folder and rejects with a `cancelled` `SyncError`.
   */
  cloneProject: (request: CloneProjectRequest, transfer: TransferMonitor, signal: AbortSignal) => Promise<ProjectFolderHandle>;
  /**
   * Publish: creates the empty repository on the host and publishes the open
   * project to it (`.gitattributes` and `.gitignore`, Integrated mode, the
   * first commit and push). Project Settings' Publish and a Remote New
   * Project share it. Resolves with how far it got; rejects only without an
   * open project.
   */
  publishToNewRepository: (repository: NewRepositoryRequest) => Promise<PublishOutcome>;
  /**
   * Why a Remote New Project opened without a repository (it stayed Local),
   * shown above the documents until dismissed or the project closes.
   */
  publishNotice: { message: string } | null;
  dismissPublishNotice: () => void;
  /** What Publish would push: assets, bytes, and the share stored through Git LFS. */
  summarizeProjectForPublish: () => Promise<PublishSummary>;
  /**
   * Records on this device whether Haptic may run Git in the open project's
   * desktop working copy (the one-Git-app warning's answer, kept in its
   * `.git/config`), then, in Integrated mode, opens or closes the Git client
   * to match. `project.json` is untouched. Rejects when it cannot be written.
   */
  setSourceControlAdoption: (adopted: boolean) => Promise<void>;
  /**
   * Runs `work` in the project write queue with the debounced save cancelled,
   * so no editor save races a pull writing project files.
   */
  withProjectWrites: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * A pull wrote `paths` while `hold` kept the documents read-only: rescans
   * the registry and classifies the changes as the foreground rescan does,
   * reloads the whole project or the clean changed documents without asking,
   * releasing `hold` in the same step, and leaves changed documents with
   * unsaved edits to the external-change prompt. Releases `hold` in any case.
   */
  applyPulledChanges: (paths: readonly string[], hold: AuthoringHold) => Promise<void>;
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
  thumbnailVersions: ThumbnailVersions;
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
    editorLodOverride?: import("@haptic/assets").EditorTextureLod | null,
    preserveSourceGuids?: ReadonlySet<string>,
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
    fontPixelSize: number;
    fontPixelSizeByGuid: Map<string, number>;
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
  collectPlayInputAssets: (requiredGuids?: ReadonlySet<string>, payloads?: ReadonlyMap<string, unknown>) => Promise<InputAssetDefinition[]>;
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
  /** True when Compile should run: never compiled this session, or open graphs changed. */
  graphsNeedCompile: boolean;
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
 * must also subscribe to the state it depends on through a narrow hook.
 */
export type DocumentActions = Pick<DocumentContextValue, DocumentActionName>;

/*
 * Narrow slices of the document context. Each object keeps its identity until
 * one of its fields changes, so its readers re-render only for that state.
 * Each picks its fields from `DocumentContextValue` under the same names.
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
export type SaveState = Pick<DocumentContextValue, "dirtyDocuments" | "projectDirty" | "autoSaveStatus" | "recoveryAvailable" | "journalPaused">;
/** `useCompileState()`: compile staleness. */
export type CompileState = Pick<DocumentContextValue, "graphsNeedCompile">;
/** `useEditorShellState()`: Homepage, recovery, prompts and thumbnails. */
export type EditorShellState = Pick<
  DocumentContextValue,
  | "listedProjects"
  | "needsReconnect"
  | "recoveryAvailable"
  | "recoveryNotice"
  | "saveFailed"
  | "templates"
  | "homepageReady"
  | "pendingExclusiveScene"
  | "externalChangePrompt"
  | "undoHistoryNotice"
  | "publishNotice"
  | "thumbnailsEnabled"
>;
/** `useSourceControl()`: a new object whenever source control state changes. */
export type SourceControlState = Pick<DocumentContextValue, "sourceControl">;

