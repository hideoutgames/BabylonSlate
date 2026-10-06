import { normalizeScene, normalizeSceneLayer, parseText2DProperties, type SerializedScene, type SerializedSceneLayer, type StorageReadMetrics } from "@babylonslate/core";
import {
  createHttpPackSource,
  createMemoryPackSource,
  parseGameManifest,
  parseScriptRegistry,
  GAME_MANIFEST_FILE,
  NAVMESH_EXPORT_TYPE,
  sceneGuidFromNavmeshExport,
  AUDIO_REVERB_EXPORT_TYPE,
  sceneGuidFromAudioReverbExport,
  FONT_FACETYPE_EXPORT_TYPE,
  AREA_EMISSION_EXPORT_TYPE,
  textureGuidFromAreaEmissionExport,
  FONT_MSDF_ATLAS_EXPORT_TYPE,
  FONT_MSDF_EXPORT_TYPE,
  fontGuidFromFontFacetypeExport,
  fontGuidFromFontMsdfAtlasExport,
  fontGuidFromFontMsdfExport,
  fontFacetypeExportGuid,
  fontMsdfExportGuid,
  fontMsdfAtlasExportGuid,
  type GameAssetIndexEntry,
  type GameManifest,
  type PackSource,
} from "@babylonslate/exporter";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  AssetLoadingService,
  cookComplexCollisionMeshes,
  modelAnimationDurations,
  sha256Hex,
  type AssetLoadScope,
  type AssetLoadPriority,
  extractPackedAudioClipBytes,
  extractPackedModelAsset,
  peekPackedAudioPayload,
  audioClipCacheKey,
  AUDIO_DEFAULT_SOURCE_CHUNK,
  normalizeAudioPayload,
  type AudioPayload,
  type ModelPayload,
  decodeAreaEmission,
  type AreaEmissionPixels,
} from "@babylonslate/assets";

const decoder = new TextDecoder();

export type LoadedGame = {
  /** Present for independently addressable exports; legacy fixture hosts may omit it. */
  assets?: AssetLoadingService;
  getReadMetrics?: () => StorageReadMetrics;
  onSourcesChanged?: (listener: () => void) => () => void;
  acquireAssets?: (ids: string[], request: { consumer: string; signal: AbortSignal; priority?: AssetLoadPriority; fontModes?: ReadonlyMap<string, ReadonlySet<"facetype" | "msdf" | "bitmap">>; onProgress?: (progress: { completed: number; total: number }) => void }) => Promise<{ release: () => void; assetGuids?: ReadonlySet<string> }>;
  acquireScene?: (guid: string, request: { consumer: string; signal: AbortSignal }) => Promise<{ scene: SerializedScene; release: () => void; assetGuids?: ReadonlySet<string> }>;
  dispose?: () => void;
  releaseStartup?: () => void;
  systemAssetGuids?: ReadonlySet<string>;
  manifest: GameManifest;
  scripts: ScriptBundleEntry[];
  scenes: Map<string, SerializedScene>;
  sceneLayers: Map<string, SerializedSceneLayer>;
  textureBytes: Map<string, Uint8Array>;
  areaEmissions: Map<string, AreaEmissionPixels>;
  modelBytes: Map<string, Uint8Array>;
  modelPayloads: Map<string, ModelPayload>;
  fontBytes: Map<string, Uint8Array>;
  fontFacetypeBytes: Map<string, Uint8Array>;
  fontMsdfJson: Map<string, Uint8Array>;
  fontMsdfPng: Map<string, Uint8Array>;
  fontFamilies: Map<string, string>;
  audioBytes: Map<string, Uint8Array>;
  audioPayloads: Map<string, AudioPayload>;
  payloads: Map<string, Uint8Array>;
  decodedPayloads?: Map<string, unknown>;
  complexMeshes?: Map<string, { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }>;
  modelAnimationDurations?: Map<string, ReadonlyMap<string, number | undefined>>;
  navmeshBytes: Map<string, Uint8Array>;
  audioReverbBytes: Map<string, Uint8Array>;
};

function textFromFiles(files: Map<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Export is missing ${name}`);
  return decoder.decode(bytes);
}

function packSourceFor(
  files: Map<string, Uint8Array>,
  packName: string,
  fetchImpl?: typeof fetch,
  baseUrl?: string,
): PackSource {
  const bytes = files.get(packName);
  if (bytes) return createMemoryPackSource(bytes);
  if (!baseUrl || !fetchImpl) {
    throw new Error(`Pack ${packName} is not in memory and no HTTP source was given`);
  }
  return createHttpPackSource(new URL(packName, baseUrl).href, undefined, fetchImpl);
}

function parseJsonAsset(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export async function loadGameFromFiles(
  files: Map<string, Uint8Array>,
  options: { fetchImpl?: typeof fetch; baseUrl?: string; signal?: AbortSignal; readFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array> } = {},
): Promise<LoadedGame> {
  const manifest = parseGameManifest(textFromFiles(files, GAME_MANIFEST_FILE));
  const scripts = parseScriptRegistry(textFromFiles(files, manifest.scriptsFile));
  const scenes = new Map<string, SerializedScene>();
  const sceneLayers = new Map<string, SerializedSceneLayer>();
  const textureBytes = new Map<string, Uint8Array>();
  const areaEmissions = new Map<string, AreaEmissionPixels>();
  const modelBytes = new Map<string, Uint8Array>();
  const modelPayloads = new Map<string, ModelPayload>();
  const fontBytes = new Map<string, Uint8Array>();
  const fontFacetypeBytes = new Map<string, Uint8Array>();
  const fontMsdfJson = new Map<string, Uint8Array>();
  const fontMsdfPng = new Map<string, Uint8Array>();
  const fontFamilies = new Map<string, string>();
  const audioBytes = new Map<string, Uint8Array>();
  const audioPayloads = new Map<string, AudioPayload>();
  const payloads = new Map<string, Uint8Array>();
  const decodedPayloads = new Map<string, unknown>();
  const complexMeshes = new Map<string, { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] }>();
  const durations = new Map<string, ReadonlyMap<string, number | undefined>>();
  const navmeshBytes = new Map<string, Uint8Array>();
  const audioReverbBytes = new Map<string, Uint8Array>();

  const packSources = new Map<string, PackSource>();
  const readMetrics: StorageReadMetrics = { operations: 2, fullReads: 2, rangeReads: 0, requestedBytes: (files.get(GAME_MANIFEST_FILE)?.byteLength ?? 0) + (files.get(manifest.scriptsFile)?.byteLength ?? 0), actualBytesRead: (files.get(GAME_MANIFEST_FILE)?.byteLength ?? 0) + (files.get(manifest.scriptsFile)?.byteLength ?? 0) };
  const entries = new Map(manifest.assets.map(entry => [entry.guid, entry]));
  for (const entry of manifest.assets) if (entry.type === "Font") fontFamilies.set(entry.guid, entry.name?.trim() || entry.guid);
  const projectId = options.baseUrl ?? `memory-export:${manifest.project?.name ?? "game"}`;
  async function readResponse(entry: GameAssetIndexEntry, response: Response): Promise<Uint8Array> {
    readMetrics.operations++;
    readMetrics.fullReads++;
    readMetrics.requestedBytes += entry.byteLength ?? 0;
    const expected = entry.byteLength;
    const length = response.headers.get("Content-Length");
    if (expected !== undefined && length !== null && !response.headers.has("Content-Encoding") && Number(length) !== expected) {
      await response.body?.cancel();
      throw new Error(`Asset ${entry.guid} has a corrupt response length (expected ${expected}, received ${length}).`);
    }
    if (expected === undefined || !response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      readMetrics.actualBytesRead += bytes.byteLength;
      if (expected === undefined) readMetrics.requestedBytes += bytes.byteLength;
      return bytes;
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(expected);
    let offset = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        readMetrics.actualBytesRead += chunk.value.byteLength;
        if (offset + chunk.value.byteLength > expected) throw new Error(`Asset ${entry.guid} exceeds its catalog byte length (${expected}).`);
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
      if (offset !== expected) throw new Error(`Asset ${entry.guid} has a corrupt response length (expected ${expected}, received ${offset}).`);
      return bytes;
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  async function read(entry: GameAssetIndexEntry, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    let bytes: Uint8Array;
    let accounted = false;
    const inMemory = entry.path ? files.get(entry.path) : undefined;
    if (inMemory) bytes = inMemory;
    else if (entry.path && options.readFile) bytes = await options.readFile(entry.path, signal);
    else if (entry.path && options.fetchImpl && options.baseUrl) {
      const response = await options.fetchImpl(new URL(entry.path, options.baseUrl).href, { signal });
      if (!response.ok) throw new Error(`Asset ${entry.guid} is missing (${entry.path}, HTTP ${response.status}).`);
      accounted = true;
      bytes = await readResponse(entry, response);
    } else if (entry.pack) {
      let source = packSources.get(entry.pack);
      if (!source) {
        source = packSourceFor(files, entry.pack, options.fetchImpl, options.baseUrl);
        packSources.set(entry.pack, source);
      }
      bytes = await source.read(entry.guid);
    } else throw new Error(`Missing bytes for asset ${entry.guid}.`);
    if (!entry.pack && !accounted) { readMetrics.operations++; readMetrics.fullReads++; readMetrics.requestedBytes += entry.byteLength ?? bytes.byteLength; readMetrics.actualBytesRead += bytes.byteLength; }
    signal.throwIfAborted();
    if (entry.byteLength !== undefined && bytes.byteLength !== entry.byteLength) throw new Error(`Asset ${entry.guid} has a corrupt length.`);
    if (entry.revision && await sha256Hex(bytes) !== entry.revision) throw new Error(`Asset ${entry.guid} has a corrupt revision.`);
    signal.throwIfAborted();
    return bytes;
  }
  type PreparedAsset = { bytes: Uint8Array; decodedBytes: number; document?: unknown; publish: () => void };
  async function decode(entry: GameAssetIndexEntry, bytes: Uint8Array): Promise<PreparedAsset> {
    const document = entry.encoding === "json" ? parseJsonAsset(bytes) : undefined;
    let decodedBytes = document === undefined ? 0 : bytes.byteLength * 2;
    let install = () => {};
    if (entry.type === "Scene") { const value = normalizeScene(document); install = () => { scenes.set(entry.guid, value); }; }
    else if (entry.type === "SceneLayer") { const value = normalizeSceneLayer(document); install = () => { sceneLayers.set(entry.guid, value); }; }
    else if (entry.type === "Texture") install = () => { textureBytes.set(entry.guid, bytes); };
    else if (entry.type === AREA_EMISSION_EXPORT_TYPE) {
      const guid = textureGuidFromAreaEmissionExport(entry.guid);
      if (!guid) throw new Error(`Invalid area emission asset identity: ${entry.guid}`);
      const value = await decodeAreaEmission(bytes);
      decodedBytes = value.rgba.byteLength;
      install = () => { areaEmissions.set(guid, value); };
    } else if (entry.type === "Model") {
      const value = extractPackedModelAsset(bytes);
      const mesh = cookComplexCollisionMeshes(new Map([[entry.guid, value.source]]), new Map([[entry.guid, value.payload]])).get(entry.guid);
      const animationDurations = modelAnimationDurations(value.source);
      decodedBytes = mesh ? mesh.vertices.length * 24 + mesh.indices.length * 8 : 0;
      install = () => { modelBytes.set(entry.guid, value.source); modelPayloads.set(entry.guid, value.payload); if (mesh) complexMeshes.set(entry.guid, mesh); durations.set(entry.guid, animationDurations); };
    } else if (entry.type === "Font") install = () => {
      fontBytes.set(entry.guid, bytes);
      if (entry.name?.trim()) fontFamilies.set(entry.guid, entry.name.trim());
    };
    else if (entry.type === FONT_FACETYPE_EXPORT_TYPE) install = () => { fontFacetypeBytes.set(fontGuidFromFontFacetypeExport(entry.guid) ?? entry.guid, bytes); };
    else if (entry.type === FONT_MSDF_EXPORT_TYPE) install = () => { fontMsdfJson.set(fontGuidFromFontMsdfExport(entry.guid) ?? entry.guid, bytes); };
    else if (entry.type === FONT_MSDF_ATLAS_EXPORT_TYPE) install = () => { fontMsdfPng.set(fontGuidFromFontMsdfAtlasExport(entry.guid) ?? entry.guid, bytes); };
    else if (entry.type === "Audio") {
      const value = peekPackedAudioPayload(bytes) ?? normalizeAudioPayload({});
      install = () => { audioPayloads.set(entry.guid, value); };
    } else if (entry.type === "CompiledScript") {
      const value = document as Partial<ScriptBundleEntry> | undefined;
      if (!value || typeof value.assetGuid !== "string" || typeof value.classId !== "string" || typeof value.source !== "string" || !Array.isArray(value.anchors) || !Array.isArray(value.entryPoints))
        throw new Error(`Compiled Class ${entry.guid} has invalid script metadata.`);
      install = () => { const index = scripts.findIndex(script => script.assetGuid === value.assetGuid && script.classId === value.classId); if (index >= 0) scripts[index] = value as ScriptBundleEntry; else scripts.push(value as ScriptBundleEntry); };
    } else if (entry.type === NAVMESH_EXPORT_TYPE) install = () => { navmeshBytes.set(sceneGuidFromNavmeshExport(entry.guid) ?? entry.guid, bytes); };
    else if (entry.type === AUDIO_REVERB_EXPORT_TYPE) install = () => { audioReverbBytes.set(sceneGuidFromAudioReverbExport(entry.guid) ?? entry.guid, bytes); };
    return { bytes, decodedBytes, document, publish: () => { payloads.set(entry.guid, bytes); if (document !== undefined) decodedPayloads.set(entry.guid, document); install(); } };
  }

  const game: LoadedGame = {
    manifest,
    scripts,
    scenes,
    sceneLayers,
    textureBytes,
    areaEmissions,
    modelBytes,
    modelPayloads,
    fontBytes,
    fontFacetypeBytes,
    fontMsdfJson,
    fontMsdfPng,
    fontFamilies,
    audioBytes,
    audioPayloads,
    payloads,
    decodedPayloads,
    complexMeshes,
    modelAnimationDurations: durations,
    navmeshBytes,
    audioReverbBytes,
  };
  const sourceListeners = new Set<() => void>();
  let notificationPending = false;
  game.onSourcesChanged = listener => { sourceListeners.add(listener); return () => { sourceListeners.delete(listener); }; };
  function evict(entry: GameAssetIndexEntry, bytes: Uint8Array): void {
    if (payloads.get(entry.guid) !== bytes) return;
    if (!notificationPending) { notificationPending = true; queueMicrotask(() => { notificationPending = false; for (const listener of sourceListeners) listener(); }); }
    payloads.delete(entry.guid);
    if (entry.type === "CompiledScript") {
      const index = scripts.findIndex(script => script.assetGuid === entry.ownerGuid && script.classId === entry.classId);
      if (index >= 0) scripts.splice(index, 1);
    }
    decodedPayloads.delete(entry.guid);
    complexMeshes.delete(entry.guid);
    durations.delete(entry.guid);
    for (const map of [scenes, sceneLayers, textureBytes, modelBytes, modelPayloads, fontBytes, audioPayloads]) map.delete(entry.guid);
    const owner = entry.guid.slice(entry.guid.indexOf(":") + 1);
    if (entry.type === AREA_EMISSION_EXPORT_TYPE) areaEmissions.delete(owner);
    if (entry.type === NAVMESH_EXPORT_TYPE) navmeshBytes.delete(owner);
    if (entry.type === AUDIO_REVERB_EXPORT_TYPE) audioReverbBytes.delete(owner);
    if (entry.type === FONT_FACETYPE_EXPORT_TYPE) fontFacetypeBytes.delete(owner);
    if (entry.type === FONT_MSDF_EXPORT_TYPE) fontMsdfJson.delete(owner);
    if (entry.type === FONT_MSDF_ATLAS_EXPORT_TYPE) fontMsdfPng.delete(owner);
    if (entry.type === "Audio") {
      audioBytes.delete(entry.guid);
      for (const key of audioBytes.keys()) if (key.startsWith(`${entry.guid}:`)) audioBytes.delete(key);
    }
  }
  const service = new AssetLoadingService({
    projectId,
    resolve: (id) => {
      const entry = entries.get(id);
      if (!entry) throw new Error(`Asset ${id} is not in the exported catalog.`);
      return { id, rootId: projectId, revision: entry.revision ?? "legacy", requiredDependencies: entry.requiredDependencies ?? [] };
    },
    representation: (record) => {
      const entry = entries.get(record.id)!;
      const size = entry.byteLength ?? 0;
      return { key: "export-source", estimate: { sourceBytes: size, decodedBytes: size * (entry.type === "Model" ? 4 : 2), temporaryBytes: size },
        load: async (_record, signal) => {
          const bytes = await read(entry, signal);
          const prepared = await decode(entry, bytes);
          signal.throwIfAborted();
          return { value: prepared, sourceBytes: bytes.byteLength, decodedBytes: prepared.decodedBytes, dispose: () => evict(entry, bytes) };
        },
      };
    },
  });
  game.assets = service;
  game.getReadMetrics = () => {
    const result = { ...readMetrics };
    for (const source of packSources.values()) { const stats = source.getReadMetrics?.(); if (stats) for (const key of Object.keys(result) as Array<keyof StorageReadMetrics>) result[key] += stats[key]; }
    return result;
  };
  async function prepare(scope: AssetLoadScope, roots: string[], signal?: AbortSignal, onProgress?: (progress: { completed: number; total: number }) => void, priority: AssetLoadPriority = "gameplay", requestedFonts?: ReadonlyMap<string, ReadonlySet<"facetype" | "msdf" | "bitmap">>) {
    const closure = new Set<string>();
    const visit = (id: string) => { if (closure.has(id)) return; closure.add(id); for (const dependency of entries.get(id)?.requiredDependencies ?? []) visit(dependency); };
    for (const root of roots) visit(root);
    const modes = new Map<string, Set<"facetype" | "msdf" | "bitmap">>();
    const requireFont = (id: string | null | undefined, mode: "facetype" | "msdf" | "bitmap") => {
      const guid = id || manifest.defaultFontGuid;
      if (!guid) return;
      visit(guid);
      const selected = modes.get(guid) ?? new Set();
      selected.add(mode);
      modes.set(guid, selected);
    };
    for (const [guid, selected] of requestedFonts ?? []) for (const mode of selected) requireFont(guid, mode);
    for (const root of roots) if (entries.get(root)?.type === "Font" && !modes.has(root)) requireFont(root, "bitmap");
    // Font metadata already lives in the catalog. Original font bytes are only
    // requested for Bitmap text; MSDF and geometry consumers select sidecars.
    const acquire = (id: string, metadataOnly = false) => scope.acquire<PreparedAsset>(id, metadataOnly ? {
      key: "export-font-catalog", estimate: { sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0 },
      load: async () => ({ value: { bytes: new Uint8Array(), decodedBytes: 0, publish() {} } }),
    } : undefined, { signal, priority, dependencies: "none" });
    const documentIds = [...closure];
    const prepared = await Promise.all(documentIds.map(id => acquire(id, entries.get(id)?.type === "Font" && manifest.assetCatalogVersion === 1)));
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const child of value) inspect(child); return; }
      const row = value as Record<string, unknown>;
      const properties = row.properties as Record<string, unknown> | undefined;
      if (row.classId === "Text3DComponent") requireFont(typeof properties?.fontAssetGuid === "string" ? properties.fontAssetGuid : undefined, "facetype");
      else if (row.classId === "2DTextComponent" || row.classId === "2DRichTextComponent") {
        const text = parseText2DProperties(properties);
        requireFont(text.fontAssetGuid, text.renderer === "msdf" ? "msdf" : "bitmap");
      }
      for (const child of Object.values(row)) if (child && typeof child === "object") inspect(child);
    };
    for (const asset of prepared) inspect(asset.document);
    const inheritModes = (guid: string, selected: ReadonlySet<"facetype" | "msdf" | "bitmap">, seen = new Set<string>()) => {
      if (seen.has(guid)) return;
      seen.add(guid);
      for (const dependency of entries.get(guid)?.requiredDependencies ?? []) if (entries.get(dependency)?.type === "Font") {
        for (const mode of selected) requireFont(dependency, mode);
        inheritModes(dependency, selected, seen);
      }
    };
    for (const [guid, selected] of modes) inheritModes(guid, selected);
    const variants = new Set<string>();
    for (const [guid, selected] of modes) {
      if (selected.has("bitmap")) variants.add(guid);
      if (selected.has("facetype")) variants.add(fontFacetypeExportGuid(guid));
      if (selected.has("msdf")) { variants.add(fontMsdfExportGuid(guid)); variants.add(fontMsdfAtlasExportGuid(guid)); }
    }
    const extraMetadata = [...closure].filter(id => !documentIds.includes(id));
    const total = prepared.length + extraMetadata.length + variants.size;
    let completed = prepared.length;
    onProgress?.({ completed, total });
    const extra = await Promise.all([
      ...extraMetadata.map(id => acquire(id, entries.get(id)?.type === "Font")),
      ...[...variants].map(id => { closure.add(id); return acquire(id); }),
    ].map(async work => { const result = await work; onProgress?.({ completed: ++completed, total }); return result; }));
    signal?.throwIfAborted();
    for (const asset of [...prepared, ...extra]) asset.publish();
    return closure;
  }
  const startupScope = service.createScope("player:startup");
  const systemScope = service.createScope("player:systems");
  const liveScopes = new Set<AssetLoadScope>([startupScope, systemScope]);
  game.releaseStartup = () => { startupScope.dispose(); liveScopes.delete(startupScope); };
  game.acquireAssets = async (ids, { consumer, signal, onProgress, priority, fontModes }) => {
    const scope = service.createScope(consumer);
    liveScopes.add(scope);
    const release = () => { liveScopes.delete(scope); scope.dispose(); };
    try { const assetGuids = await prepare(scope, ids, signal, onProgress, priority, fontModes); return { release, assetGuids }; }
    catch (error) { release(); throw error; }
  };
  game.acquireScene = async (guid, request) => {
    const source = await game.acquireAssets!([guid], request);
    const scene = scenes.get(guid);
    if (!scene) { source.release(); throw new Error(`Asset ${guid} is not a Scene.`); }
    return { scene, release: source.release, assetGuids: source.assetGuids };
  };
  game.dispose = () => { sourceListeners.clear(); for (const scope of liveScopes) scope.dispose(); liveScopes.clear(); service.dispose(); packSources.clear(); };
  const roots = manifest.assetCatalogVersion === 1
    ? manifest.assets.filter(entry => entry.guid === manifest.startupSceneGuid).map(entry => entry.guid)
    : manifest.assets.map(entry => entry.guid);
  try {
    const [, systemAssets] = await Promise.all([prepare(startupScope, roots, options.signal),
      prepare(systemScope, manifest.assets.filter(entry => entry.startupRequired).map(entry => entry.guid), options.signal)]);
    game.systemAssetGuids = systemAssets;
  }
  catch (error) { game.dispose(); throw error; }
  return game;

}

/** Unpack one Audio clip into `game.audioBytes` on first playback. */
export function loadGameAudioClipBytes(
  game: LoadedGame,
  assetGuid: string,
  chunkId: string,
): Uint8Array | null {
  const cacheKey = audioClipCacheKey(assetGuid, chunkId);
  const cached =
    game.audioBytes.get(cacheKey) ??
    (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK
      ? game.audioBytes.get(assetGuid)
      : undefined);
  if (cached && cached.byteLength > 0) return cached;
  const packed = game.payloads.get(assetGuid);
  if (!packed) return null;
  const bytes = extractPackedAudioClipBytes(packed, chunkId);
  if (!bytes || bytes.byteLength === 0) return null;
  game.audioBytes.set(cacheKey, bytes);
  if (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK) {
    game.audioBytes.set(assetGuid, bytes);
  }
  return bytes;
}

export function createGameAudioSourceLoader(
  game: LoadedGame,
): (request: { assetGuid: string; chunkId: string; revision?: string }) => Promise<Uint8Array | null> {
  return async ({ assetGuid, chunkId, revision }) => {
    const exportedRevision = game.manifest.assets.find(entry => entry.guid === assetGuid)?.revision;
    if (revision && exportedRevision && revision !== exportedRevision) throw new Error(`Audio asset ${assetGuid} source revision is no longer available.`);
    const scope = game.assets?.createScope(`audio:${assetGuid}:${chunkId}`);
    try {
      if (scope) { const prepared = await scope.acquire<{ publish: () => void }>(assetGuid); prepared.publish(); }
      return loadGameAudioClipBytes(game, assetGuid, chunkId);
    } finally { scope?.dispose(); }
  };
}

export async function loadGameFromHttp(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LoadedGame> {
  const manifestUrl = new URL(GAME_MANIFEST_FILE, baseUrl).href;
  const manifestRes = await fetchImpl(manifestUrl, { signal });
  if (!manifestRes.ok) throw new Error("Export is missing game.json");
  const manifestBytes = new Uint8Array(await manifestRes.arrayBuffer());
  const manifest = parseGameManifest(decoder.decode(manifestBytes));
  const scriptsRes = await fetchImpl(new URL(manifest.scriptsFile, baseUrl).href, { signal });
  if (!scriptsRes.ok) throw new Error(`Export is missing ${manifest.scriptsFile}`);
  const files = new Map<string, Uint8Array>([
    [GAME_MANIFEST_FILE, manifestBytes],
    [manifest.scriptsFile, new Uint8Array(await scriptsRes.arrayBuffer())],
  ]);
  return loadGameFromFiles(files, { fetchImpl, baseUrl, signal });
}
