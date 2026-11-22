import { collisionTriangleMeshBytes, normalizeScene, normalizeSceneLayer, parseText2DProperties, type CollisionTriangleMesh, type SerializedScene, type SerializedSceneLayer, type StorageReadMetrics } from "@haptic/core";
import {
  parseGameManifest,
  GAME_MANIFEST_FILE,
  NAVMESH_EXPORT_TYPE,
  sceneGuidFromNavmeshExport,
  AUDIO_REVERB_EXPORT_TYPE,
  sceneGuidFromAudioReverbExport,
  LANDSCAPE_EXPORT_TYPE,
  FOLIAGE_EXPORT_TYPE,
  componentChunkKeyFromExport,
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
  COMPLEX_COLLISION_EXPORT_TYPE,
  complexCollisionExportGuid,
  decodeComplexCollisionMesh,
  modelGuidFromComplexCollisionExport,
  type GameAssetIndexEntry,
  type GameManifest,
} from "@haptic/exporter";
import type { ScriptBundleEntry } from "@haptic/bridge";
import type { DecoderPrefetch } from "./decoder-prefetch";
import {
  AssetLoadingService,
  complexCollisionModelGuids,
  cookComplexCollisionMesh,
  installAssetBytes,
  installTextureSource,
  sha256Hex,
  type AssetLoadScope,
  type AssetLoadPriority,
  extractPackedAudioClipBytes,
  decodePackedModelAsset,
  peekPackedAudioPayload,
  audioClipCacheKey,
  AUDIO_DEFAULT_SOURCE_CHUNK,
  type AudioPayload,
  type ModelPayload,
  decodeAreaEmission,
  type AreaEmissionPixels,
} from "@haptic/assets";

const decoder = new TextDecoder();

export type LoadedGame = {
  assets: AssetLoadingService;
  getReadMetrics?: () => StorageReadMetrics;
  onSourcesChanged?: (listener: () => void) => () => void;
  acquireAssets?: (ids: string[], request: { consumer: string; signal: AbortSignal; priority?: AssetLoadPriority; fontModes?: ReadonlyMap<string, ReadonlySet<"facetype" | "msdf" | "bitmap">>; onProgress?: (progress: { completed: number; total: number }) => void }) => Promise<{ release: () => void; assetGuids?: ReadonlySet<string> }>;
  acquireScene?: (guid: string, request: { consumer: string; signal: AbortSignal }) => Promise<{ scene: SerializedScene; release: () => void; assetGuids?: ReadonlySet<string> }>;
  dispose?: () => void;
  releaseStartup?: () => void;
  systemAssetGuids?: ReadonlySet<string>;
  manifest: GameManifest;
  /**
   * The URL of the game's static scripts module (`manifest.scriptsModule`), which the game worker imports: beside
   * `game.json` when served, otherwise an object URL of its verified bytes (Preview Build, in-memory exports).
   */
  scriptsModuleUrl?: string;
  scripts: ScriptBundleEntry[];
  scenes: Map<string, SerializedScene>;
  sceneLayers: Map<string, SerializedSceneLayer>;
  /**
   * Installed sources (`installTextureSource`, `installAssetBytes`): each Blob is the only copy of its bytes, made
   * once per load with the catalog revision as its identity, so nothing hashes or holds them again.
   */
  textureBytes: Map<string, Blob>;
  areaEmissions: Map<string, AreaEmissionPixels>;
  /** Each Model's installed GLB source (see `textureBytes`). */
  modelBytes: Map<string, Blob>;
  modelPayloads: Map<string, ModelPayload>;
  fontBytes: Map<string, Uint8Array>;
  fontFacetypeBytes: Map<string, Uint8Array>;
  fontMsdfJson: Map<string, Uint8Array>;
  /** Each Font's installed MSDF atlas (see `textureBytes`). */
  fontMsdfPng: Map<string, Blob>;
  fontFamilies: Map<string, string>;
  audioBytes: Map<string, Uint8Array>;
  audioPayloads: Map<string, AudioPayload>;
  /** Direct media URLs for exported streamed Audio clip sidecars when served over HTTP/app protocol. */
  audioStreamUrls?: Map<string, string>;
  /** Fallback reader for exported streamed Audio clip sidecars in memory/file exports without baseUrl. */
  readAudioStreamClip?: (assetGuid: string, chunkId: string) => Promise<Uint8Array | null>;
  /**
   * Each loaded asset's bytes, for the payloads hydration and Audio unpacking read. An installed source (Texture,
   * Model, MSDF atlas) keeps an empty array here instead: its Blob owns its bytes.
   */
  payloads: Map<string, Uint8Array>;
  decodedPayloads?: Map<string, unknown>;
  /** Cooked only for Models a prepared Scene/Class uses with Use Complex Collision. */
  complexMeshes?: Map<string, CollisionTriangleMesh>;
  /** On-demand fallback for the runtime's `requestComplexCollision`; `null` when the Model is not loaded. */
  cookComplexCollision?: (guid: string) => Promise<CollisionTriangleMesh | null>;
  navmeshBytes: Map<string, Uint8Array>;
  audioReverbBytes: Map<string, Uint8Array>;
  /** Binary Landscape (`HPLD`) and Foliage (`HPFG`) component chunks keyed by `<ownerGuid>:<chunkId>`. */
  componentChunks: Map<string, Uint8Array>;
};

function textFromFiles(files: Map<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Export is missing ${name}`);
  return decoder.decode(bytes);
}

function parseJsonAsset(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export async function loadGameFromFiles(
  files: Map<string, Uint8Array>,
  options: {
    fetchImpl?: typeof fetch; baseUrl?: string; signal?: AbortSignal; readFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
    /** Warms the decoder runtimes the textures and Models read here need, while the rest still downloads. */
    prefetchDecoders?: DecoderPrefetch;
    /** Runs once the catalog is parsed, before any asset is read. */
    onManifest?: (manifest: GameManifest) => void;
  } = {},
): Promise<LoadedGame> {
  // Invoke native fetch as a function, never as an options-object method: a
  // browser rejects the latter's receiver with an Illegal invocation error.
  const fetchAsset = options.fetchImpl;
  const manifest = parseGameManifest(textFromFiles(files, GAME_MANIFEST_FILE));
  options.onManifest?.(manifest);
  // Compiled Class code arrives as CompiledScript sidecars when acquired.
  const scripts: ScriptBundleEntry[] = [];
  const scenes = new Map<string, SerializedScene>();
  const sceneLayers = new Map<string, SerializedSceneLayer>();
  const textureBytes = new Map<string, Blob>();
  const areaEmissions = new Map<string, AreaEmissionPixels>();
  const modelBytes = new Map<string, Blob>();
  const modelPayloads = new Map<string, ModelPayload>();
  const fontBytes = new Map<string, Uint8Array>();
  const fontFacetypeBytes = new Map<string, Uint8Array>();
  const fontMsdfJson = new Map<string, Uint8Array>();
  const fontMsdfPng = new Map<string, Blob>();
  const fontFamilies = new Map<string, string>();
  const audioBytes = new Map<string, Uint8Array>();
  const audioPayloads = new Map<string, AudioPayload>();
  const audioStreamUrls = new Map<string, string>();
  const audioStreamPaths = new Map<string, string>();
  const audioStreamRevisions = new Map<string, string>();
  const payloads = new Map<string, Uint8Array>();
  const decodedPayloads = new Map<string, unknown>();
  const complexMeshes = new Map<string, CollisionTriangleMesh>();
  const navmeshBytes = new Map<string, Uint8Array>();
  const audioReverbBytes = new Map<string, Uint8Array>();
  const componentChunks = new Map<string, Uint8Array>();

  const manifestLength = files.get(GAME_MANIFEST_FILE)?.byteLength ?? 0;
  const readMetrics: StorageReadMetrics = { operations: 1, fullReads: 1, rangeReads: 0, requestedBytes: manifestLength, actualBytesRead: manifestLength };
  const entries = new Map(manifest.assets.map(entry => [entry.guid, entry]));
  for (const entry of manifest.assets) {
    if (entry.type === "Font") fontFamilies.set(entry.guid, entry.name?.trim() || entry.guid);
    if (entry.type === "Audio" && entry.streamClips) {
      for (const [chunkId, streamPath] of Object.entries(entry.streamClips)) {
        const key = audioClipCacheKey(entry.guid, chunkId);
        audioStreamPaths.set(key, streamPath);
        const clipRevision = entry.streamRevisions?.[chunkId];
        if (clipRevision) audioStreamRevisions.set(key, clipRevision);
        if (options.baseUrl) {
          audioStreamUrls.set(key, new URL(streamPath, options.baseUrl).href);
        }
      }
    }
  }
  const projectId = options.baseUrl ?? `memory-export:${manifest.project?.name ?? "game"}`;
  // A served game's module loads by URL, as player.js does; one without a URL is read, verified and handed over as an
  // object URL (no Content Security Policy applies to Preview Build's frame).
  let scriptsModuleUrl: string | undefined;
  const scriptsModule = manifest.scriptsModule;
  if (scriptsModule && options.baseUrl) scriptsModuleUrl = new URL(scriptsModule.path, options.baseUrl).href;
  else if (scriptsModule) {
    const bytes = files.get(scriptsModule.path) ?? (options.readFile ? await options.readFile(scriptsModule.path, options.signal ?? new AbortController().signal) : null);
    if (!bytes) throw new Error(`Export is missing ${scriptsModule.path}`);
    if (bytes.byteLength !== scriptsModule.byteLength || await sha256Hex(bytes) !== scriptsModule.revision) throw new Error(`${scriptsModule.path} has a corrupt revision.`);
    scriptsModuleUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "text/javascript" }));
  }
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
    // A catalog-only entry (a Class, whose compiled scripts are its sidecars; a Font without a source file) has no file.
    if (!entry.path && entry.byteLength === 0) bytes = new Uint8Array(0);
    else if (inMemory) bytes = inMemory;
    else if (entry.path && options.readFile) bytes = await options.readFile(entry.path, signal);
    else if (entry.path && fetchAsset && options.baseUrl) {
      const response = await fetchAsset(new URL(entry.path, options.baseUrl).href, { signal });
      if (!response.ok) throw new Error(`Asset ${entry.guid} is missing (${entry.path}, HTTP ${response.status}).`);
      accounted = true;
      bytes = await readResponse(entry, response);
    } else throw new Error(`Missing bytes for asset ${entry.guid}.`);
    if (!accounted) { readMetrics.operations++; readMetrics.fullReads++; readMetrics.requestedBytes += entry.byteLength ?? bytes.byteLength; readMetrics.actualBytesRead += bytes.byteLength; }
    signal.throwIfAborted();
    if (entry.byteLength !== undefined && bytes.byteLength !== entry.byteLength) throw new Error(`Asset ${entry.guid} has a corrupt length.`);
    if (await sha256Hex(bytes) !== entry.revision) throw new Error(`Asset ${entry.guid} has a corrupt revision.`);
    signal.throwIfAborted();
    return bytes;
  }
  type PreparedAsset = { decodedBytes: number; document?: unknown; model?: { source: Blob; payload: ModelPayload }; publish: () => void };
  async function decode(entry: GameAssetIndexEntry, bytes: Uint8Array): Promise<PreparedAsset> {
    const document = entry.encoding === "json" ? parseJsonAsset(bytes) : undefined;
    let decodedBytes = document === undefined ? 0 : bytes.byteLength * 2;
    let install = () => {};
    let model: PreparedAsset["model"];
    // An installed source's Blob owns its bytes; `payloads` keeps only an empty array, unique to this load, for eviction.
    let retained = bytes;
    // Exported sidecars always carry their prefixed identity (`navmesh:<scene>`).
    const sidecarOwner = (guid: string | null) => {
      if (!guid) throw new Error(`Invalid ${entry.type} asset identity: ${entry.guid}`);
      return guid;
    };
    if (entry.type === "Scene") { const value = normalizeScene(document); install = () => { scenes.set(entry.guid, value); }; }
    else if (entry.type === "SceneLayer") { const value = normalizeSceneLayer(document); install = () => { sceneLayers.set(entry.guid, value); }; }
    else if (entry.type === "Texture") {
      options.prefetchDecoders?.texture(bytes);
      // The catalog revision is the SHA-256 `read` verified for exactly these bytes.
      const source = installTextureSource(bytes, entry.revision);
      retained = new Uint8Array(0);
      install = () => { textureBytes.set(entry.guid, source); };
    }
    else if (entry.type === AREA_EMISSION_EXPORT_TYPE) {
      const guid = textureGuidFromAreaEmissionExport(entry.guid);
      if (!guid) throw new Error(`Invalid area emission asset identity: ${entry.guid}`);
      const value = await decodeAreaEmission(bytes);
      decodedBytes = value.rgba.byteLength;
      install = () => { areaEmissions.set(guid, value); };
    } else if (entry.type === "Model") {
      const value = decodePackedModelAsset(bytes);
      if (!value) throw new Error(`Model ${entry.guid} is not a packed Model asset.`);
      options.prefetchDecoders?.model(value.source);
      // The GLB is part of the verified payload, so the payload's revision identifies it too.
      const source = installAssetBytes(value.source, "model/gltf-binary", `${entry.revision}:source`);
      retained = new Uint8Array(0);
      // Complex Collision is a separate representation, cooked in prepare() only when needed.
      model = { source, payload: value.payload };
      install = () => { modelBytes.set(entry.guid, source); modelPayloads.set(entry.guid, value.payload); };
    } else if (entry.type === "Font") install = () => {
      // A Font without a source file has only sidecars; no FontFace loads from it.
      if (bytes.byteLength > 0) fontBytes.set(entry.guid, bytes);
      if (entry.name?.trim()) fontFamilies.set(entry.guid, entry.name.trim());
    };
    else if (entry.type === FONT_FACETYPE_EXPORT_TYPE) { const guid = sidecarOwner(fontGuidFromFontFacetypeExport(entry.guid)); install = () => { fontFacetypeBytes.set(guid, bytes); }; }
    else if (entry.type === FONT_MSDF_EXPORT_TYPE) { const guid = sidecarOwner(fontGuidFromFontMsdfExport(entry.guid)); install = () => { fontMsdfJson.set(guid, bytes); }; }
    else if (entry.type === FONT_MSDF_ATLAS_EXPORT_TYPE) {
      const guid = sidecarOwner(fontGuidFromFontMsdfAtlasExport(entry.guid));
      const source = installTextureSource(bytes, entry.revision);
      retained = new Uint8Array(0);
      install = () => { fontMsdfPng.set(guid, source); };
    }
    else if (entry.type === "Audio") {
      const value = peekPackedAudioPayload(bytes);
      if (!value) throw new Error(`Audio ${entry.guid} is not a packed Audio asset.`);
      install = () => { audioPayloads.set(entry.guid, value); };
    } else if (entry.type === "CompiledScript") {
      const value = document as Partial<ScriptBundleEntry> | undefined;
      if (!value || typeof value.assetGuid !== "string" || typeof value.classId !== "string" || typeof value.source !== "string" || !Array.isArray(value.anchors) || !Array.isArray(value.entryPoints))
        throw new Error(`Compiled Class ${entry.guid} has invalid script metadata.`);
      install = () => { const index = scripts.findIndex(script => script.assetGuid === value.assetGuid && script.classId === value.classId); if (index >= 0) scripts[index] = value as ScriptBundleEntry; else scripts.push(value as ScriptBundleEntry); };
    } else if (entry.type === NAVMESH_EXPORT_TYPE) { const guid = sidecarOwner(sceneGuidFromNavmeshExport(entry.guid)); install = () => { navmeshBytes.set(guid, bytes); }; }
    else if (entry.type === AUDIO_REVERB_EXPORT_TYPE) { const guid = sidecarOwner(sceneGuidFromAudioReverbExport(entry.guid)); install = () => { audioReverbBytes.set(guid, bytes); }; }
    else if (entry.type === LANDSCAPE_EXPORT_TYPE || entry.type === FOLIAGE_EXPORT_TYPE) { const key = sidecarOwner(componentChunkKeyFromExport(entry.guid)); install = () => { componentChunks.set(key, bytes); }; }
    else if (entry.type === COMPLEX_COLLISION_EXPORT_TYPE) {
      const guid = sidecarOwner(modelGuidFromComplexCollisionExport(entry.guid));
      // The mesh's arrays are views of these bytes: the mesh is their owner.
      const mesh = decodeComplexCollisionMesh(bytes);
      decodedBytes = 0;
      retained = new Uint8Array(0);
      install = () => { complexMeshes.set(guid, mesh); };
    }
    // Every acquisition of a loaded asset publishes these same objects, and nothing edits them in place:
    // boot's `loadedSourcesChanged` and `packedContentFromGame`'s per-payload documents rely on that identity.
    return { decodedBytes, document, model, retained, publish: () => { payloads.set(entry.guid, retained); if (document !== undefined) decodedPayloads.set(entry.guid, document); install(); } } as PreparedAsset & { retained: Uint8Array };
  }

  const sourceListeners = new Set<() => void>();
  let notificationPending = false;
  function evict(entry: GameAssetIndexEntry, retained: Uint8Array): void {
    if (payloads.get(entry.guid) !== retained) return;
    if (!notificationPending) { notificationPending = true; queueMicrotask(() => { notificationPending = false; for (const listener of sourceListeners) listener(); }); }
    payloads.delete(entry.guid);
    if (entry.type === "CompiledScript") {
      const index = scripts.findIndex(script => script.assetGuid === entry.ownerGuid && script.classId === entry.classId);
      if (index >= 0) scripts.splice(index, 1);
    }
    decodedPayloads.delete(entry.guid);
    for (const map of [scenes, sceneLayers, textureBytes, modelBytes, modelPayloads, fontBytes, audioPayloads]) map.delete(entry.guid);
    const owner = entry.guid.slice(entry.guid.indexOf(":") + 1);
    if (entry.type === AREA_EMISSION_EXPORT_TYPE) areaEmissions.delete(owner);
    if (entry.type === NAVMESH_EXPORT_TYPE) navmeshBytes.delete(owner);
    if (entry.type === AUDIO_REVERB_EXPORT_TYPE) audioReverbBytes.delete(owner);
    if (entry.type === LANDSCAPE_EXPORT_TYPE || entry.type === FOLIAGE_EXPORT_TYPE) componentChunks.delete(owner);
    if (entry.type === COMPLEX_COLLISION_EXPORT_TYPE) complexMeshes.delete(owner);
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
      if (!entry.revision) throw new Error(`Asset ${id} has no revision in the exported catalog; rebuild the game.`);
      return { id, rootId: projectId, revision: entry.revision, requiredDependencies: entry.requiredDependencies ?? [] };
    },
    representation: (record) => {
      const entry = entries.get(record.id)!;
      const size = entry.byteLength ?? 0;
      return { key: "export-source", estimate: { sourceBytes: size, decodedBytes: size * 2, temporaryBytes: size },
        load: async (_record, signal) => {
          const bytes = await read(entry, signal);
          const prepared = await decode(entry, bytes) as PreparedAsset & { retained: Uint8Array };
          signal.throwIfAborted();
          const retained = prepared.retained;
          return { value: prepared, sourceBytes: bytes.byteLength, decodedBytes: prepared.decodedBytes, dispose: () => evict(entry, retained) };
        },
      };
    },
  });
  const game: LoadedGame = {
    assets: service,
    manifest,
    ...(scriptsModuleUrl ? { scriptsModuleUrl } : {}),
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
    audioStreamUrls,
    readAudioStreamClip: async (assetGuid, chunkId) => {
      const key = audioClipCacheKey(assetGuid, chunkId);
      const streamPath = audioStreamPaths.get(key);
      if (!streamPath) return null;
      const bytes =
        files.get(streamPath) ??
        (options.readFile
          ? await options.readFile(streamPath, options.signal ?? new AbortController().signal)
          : null);
      if (!bytes) return null;
      const expectedRevision = audioStreamRevisions.get(key);
      if (expectedRevision && await sha256Hex(bytes) !== expectedRevision) {
        throw new Error(`Audio stream clip ${assetGuid}:${chunkId} has a corrupt revision.`);
      }
      return bytes;
    },
    payloads,
    decodedPayloads,
    complexMeshes,
    navmeshBytes,
    audioReverbBytes,
    componentChunks,
  };
  // The cooked mesh is its own cached representation and can outlive the
  // Model's trimmed source bytes.
  game.cookComplexCollision = async guid => {
    const cooked = complexMeshes.get(guid);
    if (cooked) return cooked;
    const source = modelBytes.get(guid);
    return source ? cookComplexCollisionMesh(new Uint8Array(await source.arrayBuffer()), modelPayloads.get(guid)) : null;
  };
  game.onSourcesChanged = listener => { sourceListeners.add(listener); return () => { sourceListeners.delete(listener); }; };
  game.getReadMetrics = () => ({ ...readMetrics });
  function acquireCollision(scope: AssetLoadScope, id: string, model: { source: Blob; payload: ModelPayload }, signal?: AbortSignal, priority: AssetLoadPriority = "gameplay") {
    return scope.acquire<PreparedAsset>(id, {
      key: "export-complex-collision",
      estimate: { sourceBytes: 0, decodedBytes: model.source.size, temporaryBytes: model.source.size * 4 },
      load: async () => {
        const mesh = cookComplexCollisionMesh(new Uint8Array(await model.source.arrayBuffer()), model.payload);
        const decodedBytes = mesh ? collisionTriangleMeshBytes(mesh) : 0;
        return {
          value: { decodedBytes, publish: () => { if (mesh) complexMeshes.set(id, mesh); } },
          decodedBytes,
          dispose: () => { if (mesh && complexMeshes.get(id) === mesh) complexMeshes.delete(id); },
        };
      },
    }, { signal, priority, dependencies: "none" });
  }
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
    // requested for Bitmap text (including MSDF text without an atlas); MSDF
    // and geometry consumers select sidecars.
    const acquire = (id: string, metadataOnly = false) => scope.acquire<PreparedAsset>(id, metadataOnly ? {
      key: "export-font-catalog", estimate: { sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0 },
      load: async () => ({ value: { decodedBytes: 0, publish() {} } }),
    } : undefined, { signal, priority, dependencies: "none" });
    const documentIds = [...closure];
    const prepared = await Promise.all(documentIds.map(id => acquire(id, entries.get(id)?.type === "Font")));
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const child of value) inspect(child); return; }
      const row = value as Record<string, unknown>;
      const properties = row.properties as Record<string, unknown> | undefined;
      if (row.classId === "Text3DComponent") {
        // 3D Text without a Font draws the bundled face, never the project default Font.
        if (typeof properties?.fontAssetGuid === "string" && properties.fontAssetGuid) requireFont(properties.fontAssetGuid, "facetype");
      } else if (row.classId === "2DTextComponent" || row.classId === "2DRichTextComponent") {
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
    // A Font exports only the representations it has. 3D Text without a
    // facetype draws the bundled face; MSDF text without the full atlas pair
    // draws Bitmap, which needs the Font's own source to keep its face.
    for (const [guid, selected] of modes) {
      if (selected.has("bitmap")) variants.add(guid);
      if (selected.has("facetype") && entries.has(fontFacetypeExportGuid(guid))) variants.add(fontFacetypeExportGuid(guid));
      if (selected.has("msdf")) {
        const pair = [fontMsdfExportGuid(guid), fontMsdfAtlasExportGuid(guid)];
        if (pair.every(id => entries.has(id))) for (const id of pair) variants.add(id);
        else variants.add(guid);
      }
    }
    // The closure only grows after the snapshot, so the Fonts requireFont added follow it in insertion order.
    const extraMetadata = [...closure].slice(documentIds.length);
    // A Model's collision triangles are a separate cached representation, cooked
    // only when a Scene/Class in this closure uses Use Complex Collision.
    const needsCollision = complexCollisionModelGuids([...prepared.map(asset => asset.document), ...scripts]);
    const collisions = documentIds.flatMap((id, index) => {
      const model = prepared[index]!.model;
      if (!model || !needsCollision.has(id)) return [];
      const baked = complexCollisionExportGuid(id);
      if (entries.has(baked)) { closure.add(baked); return [acquire(baked)]; }
      return [acquireCollision(scope, id, model, signal, priority)];
    });
    const total = prepared.length + extraMetadata.length + variants.size + collisions.length;
    let completed = prepared.length;
    onProgress?.({ completed, total });
    const extra = await Promise.all([
      ...extraMetadata.map(id => acquire(id, entries.get(id)?.type === "Font")),
      ...[...variants].map(id => { closure.add(id); return acquire(id); }),
      ...collisions,
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
  game.dispose = () => {
    sourceListeners.clear(); for (const scope of liveScopes) scope.dispose(); liveScopes.clear(); service.dispose();
    if (scriptsModuleUrl?.startsWith("blob:")) URL.revokeObjectURL(scriptsModuleUrl);
  };
  // Startup reads the entry Scene's closure and the startup-required systems.
  const roots = entries.has(manifest.startupSceneGuid) ? [manifest.startupSceneGuid] : [];
  try {
    const [, systemAssets] = await Promise.all([prepare(startupScope, roots, options.signal),
      prepare(systemScope, manifest.assets.filter(entry => entry.startupRequired).map(entry => entry.guid), options.signal)]);
    game.systemAssetGuids = systemAssets;
  }
  catch (error) { game.dispose(); throw error; }
  return game;

}

/** Unpack one Audio clip into `game.audioBytes` on first playback (streamed clips stay unretained). */
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
  if (game.audioPayloads.get(assetGuid)?.playbackMode !== "streamed") {
    game.audioBytes.set(cacheKey, bytes);
    if (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK) {
      game.audioBytes.set(assetGuid, bytes);
    }
  }
  return bytes;
}

export function createGameAudioStreamUrlResolver(
  game: LoadedGame,
): (request: { assetGuid: string; chunkId: string; revision?: string }) => string | null {
  const revisions = new Map(game.manifest.assets.map(entry => [entry.guid, entry.revision]));
  return ({ assetGuid, chunkId, revision }) => {
    const exportedRevision = revisions.get(assetGuid);
    if (revision && exportedRevision && revision !== exportedRevision) return null;
    return game.audioStreamUrls?.get(audioClipCacheKey(assetGuid, chunkId)) ?? null;
  };
}

export function createGameAudioSourceLoader(
  game: LoadedGame,
): (request: { assetGuid: string; chunkId: string; revision?: string }) => Promise<Uint8Array | null> {
  const revisions = new Map(game.manifest.assets.map(entry => [entry.guid, entry.revision]));
  return async ({ assetGuid, chunkId, revision }) => {
    const exportedRevision = revisions.get(assetGuid);
    if (revision && exportedRevision && revision !== exportedRevision) throw new Error(`Audio asset ${assetGuid} source revision is no longer available.`);
    const streamedClip = await game.readAudioStreamClip?.(assetGuid, chunkId);
    if (streamedClip && streamedClip.byteLength > 0) return streamedClip;
    const scope = game.assets.createScope(`audio:${assetGuid}:${chunkId}`);
    try {
      const prepared = await scope.acquire<{ publish: () => void }>(assetGuid);
      prepared.publish();
      return loadGameAudioClipBytes(game, assetGuid, chunkId);
    } finally { scope.dispose(); }
  };
}

export async function loadGameFromHttp(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  options: Pick<NonNullable<Parameters<typeof loadGameFromFiles>[1]>, "prefetchDecoders" | "onManifest"> = {},
): Promise<LoadedGame> {
  const manifestUrl = new URL(GAME_MANIFEST_FILE, baseUrl).href;
  const manifestRes = await fetchImpl(manifestUrl, { signal });
  if (!manifestRes.ok) throw new Error("Export is missing game.json");
  const manifestBytes = new Uint8Array(await manifestRes.arrayBuffer());
  const files = new Map<string, Uint8Array>([[GAME_MANIFEST_FILE, manifestBytes]]);
  return loadGameFromFiles(files, { ...options, fetchImpl, baseUrl, signal });
}
