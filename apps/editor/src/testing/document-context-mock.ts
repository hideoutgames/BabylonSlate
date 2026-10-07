/**
 * Shared `vi.mock` module for `context/document-context`. Load it inside the
 * factory so mock hoisting cannot reorder it:
 *
 *   vi.mock("../context/document-context", async () =>
 *     (await import("../testing/document-context-mock")).documentContextMock(
 *       () => ({ openDocuments: harness.documents }),
 *     ),
 *   );
 *
 * `useValue` runs inside `useDocuments()` (it may call hooks) and returns the
 * fields the test controls. The returned object is used as-is: getters and
 * later mutations stay live, and returning the same object keeps the value's
 * identity. Fields it does not define read inert defaults: no project, no
 * open documents, actions that do nothing, and loaders that find nothing.
 * Defaults that would have to invent project content reject instead.
 *
 * Unless the test supplies them, `documentRevisions` (every kind) and
 * `tabsRevision` advance whenever the value's `openDocuments` array is
 * replaced, so memos keyed on revisions follow the test's documents as they
 * would follow edits in the real provider.
 *
 * `useDocumentActions()` returns that same value (it carries every action) and
 * `useAppRoute()` its `route`. The slice hooks (`useRegistryState`,
 * `useProjectState`, `useSaveState`, …) return objects with the value's own
 * field names, so they return the same documents value, as does any `use…`
 * hook added later without an entry here. Hooks returning one field or one
 * document (`useActiveDocumentId`, `useOpenDocument`, …) read it from the
 * value; add an entry for any new such hook.
 */
import type { ReactNode } from "react";
import { ASSET_DOCUMENT_KINDS, type DocumentKind } from "@babylonslate/core";
import { documentKindsRevision, type DocumentRevisions } from "../services/document-service";
import type { ExtensionSnapshot } from "../services/editor-extension-service";
import { SourceControlService } from "../services/source-control-service";

type DocumentContextModule = typeof import("../context/document-context");
export type DocumentsValue = ReturnType<DocumentContextModule["useDocuments"]>;
/** Fields a test supplies; anything else falls back to the inert default. */
export type DocumentsOverrides = { readonly [K in keyof DocumentsValue]?: unknown };

function unavailable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} is not mocked in this test.`);
  };
}

const noop = () => {};
const resolved = async () => {};
const unsubscribe = () => noop;

function inertExtensionService(): DocumentsValue["extensionService"] {
  const snapshot: ExtensionSnapshot = { entries: [], commands: [], diagnostics: [] };
  const service: { [K in keyof DocumentsValue["extensionService"]]: DocumentsValue["extensionService"][K] } = {
    subscribe: unsubscribe,
    getSnapshot: () => snapshot,
    setEngineStorage: noop,
    setAssetWriteGuard: noop,
    refresh: resolved,
    close: resolved,
    create: unavailable("extensionService.create"),
    readSource: unavailable("extensionService.readSource"),
    save: resolved,
    remove: resolved,
    export: unavailable("extensionService.export"),
    import: unavailable("extensionService.import"),
    getOverrides: () => ({}),
    run: resolved,
  };
  // The class's private fields are not part of the public contract.
  return service as unknown as DocumentsValue["extensionService"];
}

const KINDS: readonly DocumentKind[] = ["content-browser", ...ASSET_DOCUMENT_KINDS];

/** One revision per `openDocuments` array: replacing the array advances every kind. */
function revisionsFollowingDocuments(): (documents: unknown) => DocumentRevisions {
  const byDocuments = new WeakMap<object, DocumentRevisions>();
  const none = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as DocumentRevisions;
  let sequence = 0;
  return (documents) => {
    if (typeof documents !== "object" || documents === null) return none;
    let revisions = byDocuments.get(documents);
    if (!revisions) {
      sequence += 1;
      revisions = Object.fromEntries(KINDS.map((kind) => [kind, sequence])) as DocumentRevisions;
      byDocuments.set(documents, revisions);
    }
    return revisions;
  };
}

// useSyncExternalStore requires a stable snapshot.
const UNLOCKED_AUTHORING = Object.freeze({ readOnly: false, reason: null, revision: 0 } as const);

function inertDocuments(current: () => DocumentsValue | undefined): DocumentsValue {
  const revisionsFor = revisionsFollowingDocuments();
  return {
    lockAuthoring: unsubscribe,
    beginSimulationDocument: () => { throw new Error("No Simulation document in this fixture"); },
    getAuthoringLock: () => UNLOCKED_AUTHORING,
    subscribeAuthoringLock: unsubscribe,
    lockAuthoringWrites: () => ({ ready: Promise.resolve(true), release: noop }),
    registerBeforeTransition: () => noop,
    withSceneWrite: async work => work({
      writeSceneNavmeshChunk: (...args) => current()?.writeSceneNavmeshChunk(...args) ?? Promise.resolve(),
      writeSceneAudioReverbChunk: (...args) => current()?.writeSceneAudioReverbChunk(...args) ?? Promise.resolve(),
    }),
    route: "home",
    projectDocument: null,
    projectName: null,
    assetRegistry: null,
    createAssetLoadScope: () => { throw new Error("createAssetLoadScope is not mocked in this test."); },
    getAssetLoadState: () => "unloaded",
    extensionService: inertExtensionService(),
    projectGuid: null,
    registryEpoch: 0,
    refreshAssetRegistry: resolved,
    noteAssetsCreated: noop,
    pluginDescriptors: [],
    pluginDiagnostics: [],
    showPluginContent: false,
    setShowPluginContent: noop,
    applyPluginOverrides: resolved,
    createProjectPlugin: unavailable("createProjectPlugin"),
    deleteProjectPlugin: resolved,
    exportPlugin: unavailable("exportPlugin"),
    importPlugin: unavailable("importPlugin"),
    repathDocument: noop,
    renameAsset: unavailable("renameAsset"),
    subscribeDocumentIdentity: unsubscribe,
    retryFailedTextureEncoding: async () => 0,
    prepareAreaEmission: resolved,
    collectPlayAreaEmissions: async () => new Map(),
    retryTextureEncoding: async () => false,
    textureAlignmentStale: async () => false,
    textureUsageBlockedReason: () => null,
    onSessionDiagnostic: unsubscribe,
    openDocuments: [],
    // Live like the provider's: reads the latest value's open documents.
    getOpenDocuments: () => current()?.openDocuments ?? [],
    get documentRevisions() {
      return revisionsFor(current()?.openDocuments);
    },
    get tabsRevision() {
      return revisionsFor(current()?.openDocuments).scene;
    },
    tabOrder: [],
    activeDocumentId: null,
    listedProjects: [],
    needsReconnect: false,
    recoveryAvailable: false,
    dirtyDocuments: [],
    projectDirty: false,
    autoSaveStatus: null,
    migrationPending: [],
    templates: [],
    homepageReady: false,
    refreshTemplates: resolved,
    openProject: resolved,
    createEmptyProject: resolved,
    createFromTemplate: resolved,
    openListedProject: resolved,
    updateListedProject: resolved,
    removeListedProject: resolved,
    reconnectProject: resolved,
    saveProject: async () => true,
    saveAll: async () => true,
    approveMigrationsAndSave: resolved,
    closeProject: async () => ({ blocked: false, dirty: [], projectDirty: false }),
    forceCloseProject: resolved,
    exportProject: async () => new Uint8Array(),
    exportGameArtifact: unavailable("exportGameArtifact"),
    zipExportedGame: () => new Uint8Array(),
    dismissRecovery: resolved,
    keepRecovery: noop,
    openDocument: resolved,
    ensureAssetDocument: unavailable("ensureAssetDocument"),
    openRecordedTrace: resolved,
    pendingExclusiveScene: null,
    confirmExclusiveSceneOpen: resolved,
    cancelExclusiveSceneOpen: noop,
    closeDocument: noop,
    closeDocumentsForPaths: noop,
    replaceClassReferencesBeforeDelete: resolved,
    repairAfterAssetDelete: resolved,
    setActiveDocument: noop,
    reorderTabs: noop,
    reorderClosableTabs: noop,
    updateScene: noop,
    updateGraph: noop,
    applyGraphChange: async () => false,
    reparentClassDocument: async () => null,
    applySceneChange: async () => false,
    applyAssetDocumentChange: async () => false,
    readAssetChunk: async () => null,
    writeAudioClipChunk: resolved,
    removeAudioClipChunk: resolved,
    writeSceneNavmeshChunk: resolved,
    writeSceneAudioReverbChunk: resolved,
    updateProjectVersion: noop,
    updateProjectSettings: noop,
    sourceControl: new SourceControlService(),
    prefillSourceControlFromGit: unavailable("prefillSourceControlFromGit"),
    externalChangePrompt: null,
    confirmExternalChangeReloadProject: resolved,
    confirmExternalChangeReloadDocs: resolved,
    dismissExternalChange: noop,
    undoActiveDocument: noop,
    redoActiveDocument: noop,
    canUndoActiveDocument: false,
    canRedoActiveDocument: false,
    undoHistoryNotice: null,
    dismissUndoHistoryNotice: noop,
    registerDockviewApi: noop,
    unregisterDockviewApi: noop,
    captureLayoutForId: noop,
    animEditorMode: "stateMachine",
    setAnimEditorMode: noop,
    sceneMode: "design",
    setSceneMode: noop,
    activateDockPanel: noop,
    toggleDockWindow: noop,
    isDockWindowOpen: () => false,
    getOpenDockWindowCount: () => 0,
    isLayoutFocused: false,
    toggleLayoutFocus: noop,
    loadAssetThumbnail: async () => null,
    writeAssetThumbnail: resolved,
    thumbnailVersions: {},
    thumbnailsEnabled: false,
    collectPlayPreviewScripts: async () => ({ bundles: [], diagnostics: [] }),
    collectEditorUtilityScripts: async () => [],
    loadAssetDocument: async () => null,
    collectPlayAnimGraphs: async () => [],
    collectPlayBehaviourTrees: async () => [],
    collectPlayBlackboards: async () => [],
    collectPlaySpritePayloads: async () => new Map(),
    collectPlaySpriteAnimationPayloads: async () => new Map(),
    collectPlayWaterContent: async () => new Map(),
    collectPlayDataAssets: async () => [],
    collectPlayRenderTargets: async () => ({ renderTargets: new Map(), renderTargetTextures: new Map() }),
    collectPlayTilemapContent: async () => ({ tilemaps: new Map(), tilesets: new Map() }),
    collectPlayTextureBytes: async () => new Map(),
    collectPlayTexturePixelSizes: () => new Map(),
    collectPlayFontFacetypeBytes: async () => new Map(),
    collectPlayFontMsdfPair: async () => new Map(),
    collectPlayFontFaceEntries: async () => [],
    collectPlayFontCssStacks: () => ({ fontCssStack: "sans-serif", fontCssStackByGuid: new Map() }),
    collectPlayModelBytes: async () => new Map(),
    collectPlayModelPayloads: async () => new Map(),
    collectPlayInputAssets: async () => [],
    collectPlayAudio: unavailable("collectPlayAudio"),
    collectPlayMaterialLibrary: async () => ({ documents: new Map(), functions: new Map(), textureGuids: [] }),
    collectPlayParticles: unavailable("collectPlayParticles"),
    collectPlaySceneLibrary: async () => [],
    collectPlaySceneLayers: async () => ({ layers: [], overlayScenes: [], graphMaterialGuids: [] }),
    loadGraphDocument: async () => null,
    scriptsStale: false,
    graphsNeedCompile: false,
    currentGraphSignature: "",
    playPreviewBundles: [],
    playPreviewDiagnostics: [],
    playLoadedSignature: null,
    searchIndex: null,
  };
}

/** Reads the test's own fields first and the inert defaults for the rest. */
function withDefaults(overrides: object, defaults: DocumentsValue): DocumentsValue {
  return new Proxy(overrides, {
    get: (target, key, receiver) =>
      Reflect.has(target, key)
        ? Reflect.get(target, key, receiver)
        : Reflect.get(defaults, key),
    has: (target, key) => Reflect.has(target, key) || Reflect.has(defaults, key),
    ownKeys: (target) => [
      ...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(defaults)]),
    ],
    getOwnPropertyDescriptor: (target, key) => {
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own || !Reflect.has(defaults, key)) return own;
      return { configurable: true, enumerable: true, writable: true, value: Reflect.get(defaults, key) };
    },
  }) as DocumentsValue;
}

function isHookName(key: string | symbol): key is string {
  return typeof key === "string" && /^use[A-Z]/.test(key);
}

/** A complete `context/document-context` module for `vi.mock`. */
export function documentContextMock(
  useValue: () => DocumentsOverrides = () => ({}),
  options: { useDockWindowTick?: () => number } = {},
): DocumentContextModule {
  let current: DocumentsValue | undefined;
  let defaults: DocumentsValue | undefined;
  const values = new WeakMap<object, DocumentsValue>();
  const useDocuments = (): DocumentsValue => {
    const overrides = useValue();
    defaults ??= inertDocuments(() => current);
    let value = values.get(overrides);
    if (!value) {
      value = withDefaults(overrides, defaults);
      values.set(overrides, value);
    }
    current = value;
    return value;
  };
  const moduleExports = {
    DocumentProvider: ({ children }: { children: ReactNode }) => children,
    useDocuments,
    // The documents value carries every action, so it serves the narrow hooks.
    useDocumentActions: useDocuments,
    useAppRoute: () => useDocuments().route,
    useDockWindowTick: options.useDockWindowTick ?? (() => 0),
    // Slices use the value's field names, so the value serves them as-is.
    useProjectState: useDocuments,
    useRegistryState: useDocuments,
    useActiveDocumentState: useDocuments,
    useSaveState: useDocuments,
    useCompileState: useDocuments,
    useEditorShellState: useDocuments,
    useSourceControl: useDocuments,
    // Single-value narrow hooks read their field of the same value.
    useActiveDocumentId: () => useDocuments().activeDocumentId,
    useTabOrder: () => useDocuments().tabOrder,
    useOpenDocumentTabs: () => useDocuments().openDocuments,
    useOpenDocument: (id: string | null | undefined) => {
      const { openDocuments } = useDocuments();
      return id ? openDocuments.find((doc) => doc.id === id) : undefined;
    },
    useDocumentDirty: (id: string | null | undefined) => {
      const { openDocuments } = useDocuments();
      return Boolean(id && openDocuments.find((doc) => doc.id === id)?.dirty);
    },
    useDocumentKindsRevision: (kinds: readonly DocumentKind[]) =>
      documentKindsRevision(useDocuments().documentRevisions, kinds),
  };
  return new Proxy(moduleExports, {
    has: (target, key) => Reflect.has(target, key) || isHookName(key),
    get: (target, key) => {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      return isHookName(key) ? useDocuments : undefined;
    },
  }) as DocumentContextModule;
}
