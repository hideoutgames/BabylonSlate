import {
  SourceRevisionChangedError, areaEmissionTextureGuids, collisionTriangleMeshBytes, nearestTextureFiltering, normalizeScene, normalizeSceneLayer,
  parseText2DProperties, readTimelineClipSummaries, renderEffectsAssetGuids, timelineClipSummaries,
  type CollisionTriangleMesh, type ProjectDocument, type SerializedScene,
} from "@haptic/core";
import {
  isAssetSourceRevisionChanged, AUDIO_DEFAULT_SOURCE_CHUNK, FONT_FACETYPE_CHUNK_ID, FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID,
  compileText2DFontStacks, complexCollisionModelGuids, cookComplexCollisionMesh, createDefaultMigrationRegistry, createLimiter, createReadAhead, currentAreaEmissionChunk, decodeAreaEmission, DOCUMENT_CHUNK_ID,
  normalizeAudioPayload, normalizeFontPayload, normalizeModelPayload,
  registryAssetRepresentation, selectTextureChunk, type AssetLoadPriority, type AssetLoadScope, type AssetRegistry, type AssetSourceLocator,
  type IndexedAsset, type ModelPayload, type RegistryLoadedAsset,
} from "@haptic/assets";
import { packedContentFromGame, packedPlayControls, packedSourceControls, type GameSourceContent, type PackedGameContent } from "@haptic/exporter";
import type { SceneSourceAssets } from "@haptic/render";
import { spawnableLightsOfLoad } from "@haptic/render/spawnable-lights";
import type { ControlMessage, ScriptBundleEntry } from "@haptic/bridge";
import type { Diagnostic } from "@haptic/scripting";
import { assetHeaderDependencyMetadata, classIdFromClassAsset } from "../lib/content-browser-helpers";
import { ownedActorsOfScene, ownedTimelineClipsOfScene } from "../lib/owned-actor-gets";
import { persistableDocumentContent } from "../lib/scene-layer-document";
import type { OpenDocument } from "./document-service";

export interface PlayDocumentOverride {
  readonly payload: Record<string, unknown>;
  readonly cacheKey: string;
  readonly requiredDependencies: readonly string[];
}

const documentIdentities = new WeakMap<object, number>();
let nextDocumentIdentity = 0;

/**
 * Existing immutable working documents only: this never reads closed asset payloads. Each override's
 * payload and dependency metadata are derived when a preparation first reads them, so only the open
 * documents a closure reaches pay for it; the schema catalog they resolve against is built once.
 */
export function playDocumentOverrides(registry: AssetRegistry, documents: readonly OpenDocument[]): ReadonlyMap<string, PlayDocumentOverride> {
  const assets = registry.list();
  const byPath = new Map(assets.map(asset => [asset.path, asset]));
  const overrides = new Map<string, PlayDocumentOverride>();
  let schemas: IndexedAsset[] | undefined;
  // Schema metadata follows open Class/Structure documents as well as scene values.
  const schemaCatalog = (): IndexedAsset[] => {
    if (schemas) return schemas;
    const catalog = assets.map(asset => {
      const override = overrides.get(asset.header.guid);
      return override ? { ...asset, header: { ...asset.header, payload: override.payload } } : asset;
    });
    for (const asset of catalog) {
      const override = overrides.get(asset.header.guid);
      if (override && asset.header.type === "Class") {
        asset.header.requiredVariableNames = assetHeaderDependencyMetadata(asset.header.type, override.payload, catalog, asset.header.parentClass).requiredVariableNames;
      }
    }
    return schemas = catalog;
  };
  for (const document of documents) {
    const asset = byPath.get(document.ref.path);
    const content = document.content;
    if (!asset || !content || document.ref.kind === "trace") continue;
    let identity = documentIdentities.get(content);
    if (identity === undefined) { identity = ++nextDocumentIdentity; documentIdentities.set(content, identity); }
    const { kind } = document.ref;
    const { type, parentClass } = asset.header;
    let payload: Record<string, unknown> | undefined;
    let requiredDependencies: readonly string[] | undefined;
    overrides.set(asset.header.guid, {
      get payload() { return payload ??= persistableDocumentContent(kind, content) as Record<string, unknown>; },
      cacheKey: `working-document:${identity}`,
      get requiredDependencies() {
        return requiredDependencies ??= assetHeaderDependencyMetadata(type, this.payload, schemaCatalog(), parentClass).requiredDependencies;
      },
    });
  }
  return overrides;
}

export interface PlayAssetSourceHost {
  registry: AssetRegistry;
  project: ProjectDocument;
  /** Fixed launch snapshots also used by subsequent streamed/demand acquisitions. */
  documentOverrides?: ReadonlyMap<string, PlayDocumentOverride>;
  createScope: (owner: string) => AssetLoadScope;
  /**
   * `compile` carries the breakpoint check and the graph debugger's execution probes (editor Play and
   * Simulation). Compiled scripts stay cached after a session ends, so they are keyed on this: a host
   * that compiles without them is never handed scripts that have them, nor the other way round.
   */
  traceExecution?: boolean;
  /** `stored`: the closure's stored documents preparation has read, by guid, for the compile to reuse. */
  compile: (required: ReadonlySet<string>, stored: ReadonlyMap<string, StoredPlayDocument>) =>
    Promise<{ bundles: ScriptBundleEntry[]; diagnostics: readonly Diagnostic[] }>;
  /**
   * The Play session's storage checks: each asset's revision as a closure walk last read it from storage.
   * A later acquisition of the session trusts one while the registry still indexes that revision, so a slot
   * reads storage only for assets new to the session or indexed anew since (a save, encode, bake or
   * foreground rescan). A retry trusts none. Omitted, every walk reads every catalog from storage.
   */
  verifiedRevisions?: Map<string, string>;
}

/** A document as storage holds it: its asset type, schema version and payload. */
export type StoredPlayDocument = { type: string; version: number; payload: Record<string, unknown> };

const assetFormats = createDefaultMigrationRegistry();

/**
 * Resolve mutable catalogs before using their dependency edges for a cold load.
 * Play reads stored payloads without migrating them, so every required asset
 * not open as a working document must be at its type's current version.
 */
async function currentRequiredPlayAssets(host: PlayAssetSourceHost, roots: readonly string[], signal: AbortSignal,
  known?: ReadonlyMap<string, string>, trust = false): Promise<Map<string, string>> {
  const { registry } = host;
  const revisions = new Map<string, string>();
  // Assets this preparation already resolved, with their dependencies, are not read again.
  const resolved = (guid: string) => revisions.has(guid) || known?.has(guid) === true;
  const pending = [...roots];
  signal.throwIfAborted();
  // Each asset's catalog read starts as soon as a referrer names it, so the storage
  // round trips of siblings overlap (bounded). Assets are still visited, validated and
  // recorded in the order the stack yields them, so the closure's insertion order and the
  // first error stay those of a one-at-a-time walk.
  // The reads answer to the walk, not only to the caller: when the walk ends, by failing as
  // much as by finishing, reads still queued never start and running ones are cancelled, so
  // they cannot overlap a retry or reindex an asset under it.
  const walk = new AbortController();
  const abortWalk = () => walk.abort(signal.reason);
  signal.addEventListener("abort", abortWalk, { once: true });
  const limit = createLimiter(CATALOG_READS);
  const reads = new Map<string, Promise<AssetSourceLocator>>();
  const startRead = (guid: string): Promise<AssetSourceLocator> => {
    let read = reads.get(guid);
    if (!read) {
      // A catalog this session already read from storage, at the revision the registry still indexes, is not read again.
      const verified = trust ? verifiedLocator(host, guid) : undefined;
      read = verified ? Promise.resolve(verified) : limit(() => {
        walk.signal.throwIfAborted();
        return cancellableCatalogRead(registry.getAssetLocator(guid, { signal: walk.signal }), walk.signal);
      });
      // The walk may fail before it reaches this asset; that failure is then moot.
      read.catch(() => undefined);
      reads.set(guid, read);
    }
    return read;
  };
  const prefetch = (guids: readonly string[]) => {
    // The stack pops from the end, so the last name is read first.
    for (let index = guids.length - 1; index >= 0; index--) if (!resolved(guids[index]!)) startRead(guids[index]!);
  };
  try {
    prefetch(pending);
    while (pending.length) {
      signal.throwIfAborted();
      const guid = pending.pop()!;
      if (resolved(guid)) continue;
      const locator = await startRead(guid);
      signal.throwIfAborted();
      const asset = registry.getByGuid(guid);
      if (!asset || asset.placeholder || asset.locator !== locator) throw new SourceRevisionChangedError(`Required asset changed while resolving: ${guid}`);
      if (!host.documentOverrides?.has(guid)) assetFormats.requireCurrent(asset.header.type, asset.header.version);
      revisions.set(guid, locator.revision);
      host.verifiedRevisions?.set(guid, locator.revision);
      const dependencies = host.documentOverrides?.get(guid)?.requiredDependencies ?? registry.requiredDependenciesFor(guid, asset.header);
      pending.push(...dependencies);
      prefetch(dependencies);
    }
    return revisions;
  } finally {
    signal.removeEventListener("abort", abortWalk);
    walk.abort();
  }
}

/** The registry's locator for an asset when it is still at the revision this session verified against storage. */
function verifiedLocator(host: PlayAssetSourceHost, guid: string): AssetSourceLocator | undefined {
  const revision = host.verifiedRevisions?.get(guid);
  if (revision === undefined) return undefined;
  const asset = host.registry.getByGuid(guid);
  return asset && !asset.placeholder && asset.locator?.revision === revision ? asset.locator : undefined;
}

/** Concurrent catalog (locator) reads while resolving a closure. The loader's own cap covers payload reads only. */
const CATALOG_READS = 8;
/** Assets whose documents or chunks are requested at once: the one being processed plus the five after it. */
const READ_AHEAD = 6;

/**
 * A closure document's encoded size for cache accounting, without serializing a stored one: its stored
 * document chunk, or the header that carries its payload inline. A working document is measured as JSON.
 */
function documentByteEstimate(host: PlayAssetSourceHost, guid: string, payload: Record<string, unknown>): number {
  const asset = host.documentOverrides?.has(guid) ? undefined : host.registry.getByGuid(guid);
  const stored = asset?.header.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID)?.byteLength ?? asset?.locator?.payloadOffset;
  return stored ?? JSON.stringify(payload).length;
}

function cancellableCatalogRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Asset preparation cancelled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function requiredProjectAssets(registry: AssetRegistry, project: ProjectDocument): string[] {
  const settings = project.settings;
  const roots = [settings.audio.audioMixerGuid, ...renderEffectsAssetGuids(settings.render.effects)];
  const classes = registry.list().filter(asset => asset.header.type === "Class");
  // Game Instance and parentClass settings name compile class ids.
  const byId = new Map(classes.map(asset => [classIdFromClassAsset(asset), asset] as const));
  const classId = settings.gameInstanceClass;
  const asset = classId ? byId.get(classId) : undefined;
  if (asset) roots.push(asset.header.guid);
  const subsystemClasses = classes.filter(asset => {
    const seen = new Set<string>();
    let parent = asset.header.parentClass;
    while (parent && !seen.has(parent)) {
      if (parent === "GameSubsystem" || parent === "SceneSubsystem") return true;
      seen.add(parent);
      parent = byId.get(parent)?.header.parentClass;
    }
    return false;
  });
  const parents = new Set(subsystemClasses.flatMap(asset => {
    const parent = asset.header.parentClass && byId.get(asset.header.parentClass);
    return parent ? [parent.header.guid] : [];
  }));
  for (const subsystem of subsystemClasses) if (!parents.has(subsystem.header.guid)) roots.push(subsystem.header.guid);
  return [...new Set(roots.filter((guid): guid is string => Boolean(guid)))];
}

function selectedChunks(asset: IndexedAsset, payload: Record<string, unknown>, fonts: ReadonlyMap<string, ReadonlySet<string>>, emissions: ReadonlySet<string>): string[] {
  const { header } = asset;
  if (header.type === "Texture") {
    const chunks = [selectTextureChunk(header).chunk.id];
    if (emissions.has(header.guid)) {
      const emission = currentAreaEmissionChunk(header);
      if (!emission) throw new Error(`Texture ${header.name} needs Prepare Emission before its rectangular light can load`);
      chunks.push(emission.id);
    }
    return chunks;
  }
  if (header.type === "Model") return header.chunks.filter((entry) => entry.id === "source").map((entry) => entry.id);
  if (header.type === "Audio") {
    return normalizeAudioPayload(payload).clips.map((clip) => clip.chunkId);
  }
  if (header.type === "Font") return [...(fonts.get(header.guid) ?? [])];
  if (header.type === "Scene") return header.chunks.filter((entry) => entry.id === "navmesh" || entry.id === "audioReverb").map((entry) => entry.id);
  return [];
}

type PlayAssetSourceOptions = {
  consumer: string;
  signal: AbortSignal;
  /** Scheduling order of this acquisition's source reads and decodes; default gameplay. */
  priority?: AssetLoadPriority;
  onProgress?: (progress: { completed: number; total: number }) => void;
  allowCompileErrors?: boolean;
  fontModes?: import("@haptic/render").CommandFontModes;
};

/** A background bake/save may invalidate a snapshot; retry the complete owned acquisition. */
export async function acquirePlayAssetSources(
  host: PlayAssetSourceHost,
  roots: readonly string[],
  options: PlayAssetSourceOptions,
) {
  for (let attempt = 1; ; attempt++) {
    options.signal.throwIfAborted();
    // A retry follows a source change: it reads every catalog from storage again, trusting no earlier check.
    try { return await acquirePlayAssetSourcesAttempt(host, roots, options, attempt === 1); }
    catch (error) {
      options.signal.throwIfAborted();
      if (!isAssetSourceRevisionChanged(error)) throw error;
      if (attempt === 3) throw new Error(`Asset preparation for ${options.consumer} could not stabilize after 3 attempts; wait for saving or baking to finish, then retry. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

/** A shared preparation contract for initial Play, streamed Scenes and explicit preloads. */
async function acquirePlayAssetSourcesAttempt(
  host: PlayAssetSourceHost,
  roots: readonly string[],
  options: PlayAssetSourceOptions,
  trust: boolean,
) {
  const catalogRevisions = await currentRequiredPlayAssets(host, roots, options.signal, undefined, trust);
  const required = new Set(catalogRevisions.keys());
  const scope = host.createScope(options.consumer);
  const project = host.project;
  const audioChunks = new Map<string, Map<string, Uint8Array>>();
  const audioRevisions = new Map<string, string>();
  const complexMeshes: PackedGameContent["complexMeshes"] = new Map();
  const controls: ControlMessage[] = [];
  const fonts: Array<NonNullable<SceneSourceAssets["fonts"]>[number]> = [];
  let ownedContent: PackedGameContent | undefined;
  const game: GameSourceContent = {
    manifest: {
      assetCatalogVersion: 1, startupSceneGuid: roots.find((id) => host.registry.getByGuid(id)?.header.type === "Scene") ?? "",
      bundleDebugger: true, render: project.settings.render, playFrameCap: project.settings.playFrameCap,
      garbageCollectionIntervalTicks: project.settings.garbageCollectionIntervalTicks,
      pixelsPerUnit: project.settings.twoD.pixelsPerUnit, sortingLayers: project.settings.twoD.sortingLayers,
      pixelPerfect: project.settings.twoD.pixelPerfect, nearestTextures: nearestTextureFiltering(project.settings.twoD), physicsWorld: "3d", collisionPresets: project.settings.physics.collisionPresets,
      audioMixerGuid: project.settings.audio.audioMixerGuid ?? undefined,
      assets: [],
    },
    scripts: [], scenes: new Map(), sceneLayers: new Map(), textureBytes: new Map(), areaEmissions: new Map(),
    modelBytes: new Map(), modelPayloads: new Map(), fontBytes: new Map(), fontFacetypeBytes: new Map(),
    fontMsdfJson: new Map(), fontMsdfPng: new Map(), fontFamilies: new Map(), audioBytes: new Map(),
    audioPayloads: new Map(), payloads: new Map(), decodedPayloads: new Map(), navmeshBytes: new Map(), audioReverbBytes: new Map(),
    complexMeshes,
  };
  // One cache entry per Model revision: up-front and on-demand cooking share it,
  // so a Model is cooked at most once while any consumer retains it.
  const cookModelCollision = (guid: string, source: Uint8Array, model: ModelPayload, signal: AbortSignal) => scope.acquire(guid, {
    key: `model-cpu:collision-v2:${host.documentOverrides?.get(guid)?.cacheKey ?? "saved"}`,
    estimate: { sourceBytes: 0, decodedBytes: source.byteLength, temporaryBytes: source.byteLength * 3 },
    load: async (_asset, loadSignal) => {
      loadSignal.throwIfAborted();
      const mesh = cookComplexCollisionMesh(source, model);
      return { value: mesh, sourceBytes: 0, decodedBytes: mesh ? collisionTriangleMeshBytes(mesh) : 0 };
    },
  }, { signal, priority: options.priority, dependencies: "none", refresh: false });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // These containers belong only to this acquisition. Cached metadata and
    // another consumer's containers stay intact while their scopes survive.
    if (ownedContent) releasePackedContent(ownedContent);
    fonts.length = 0;
    audioChunks.clear();
    audioRevisions.clear();
    game.scripts = [];
    controls.length = 0;
    for (const value of Object.values(game)) if (value instanceof Map) value.clear();
    scope.dispose();
  };
  try {
    // First read authored documents to select the exact binary representations.
    const documents = new Map<string, RegistryLoadedAsset>();
    const fontModes = new Map<string, Set<string>>();
    // `required` in insertion order. Fonts discovered while reading documents append to it,
    // so the document pass below walks it by index rather than iterating a snapshot.
    const order = [...required];
    const requireFont = async (guid: string | null | undefined, chunks: readonly string[]) => {
      if (!guid) return;
      const modes = fontModes.get(guid) ?? new Set<string>();
      for (const chunk of chunks) modes.add(chunk);
      fontModes.set(guid, modes);
      for (const [dependency, revision] of await currentRequiredPlayAssets(host, [guid], options.signal, catalogRevisions, trust)) {
        const previous = catalogRevisions.get(dependency);
        if (previous && previous !== revision) throw new SourceRevisionChangedError(`Asset ${dependency} changed while resolving font dependencies; retry`);
        catalogRevisions.set(dependency, revision);
        if (!required.has(dependency)) { required.add(dependency); order.push(dependency); }
      }
    };
    for (const [guid, modes] of options.fontModes ?? []) {
      const chunks = [...modes].flatMap(mode => mode === "facetype" ? [FONT_FACETYPE_CHUNK_ID]
        : mode === "msdf" ? [FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID] : ["source"]);
      await requireFont(guid || project.settings.fonts.defaultFontGuid, chunks);
    }
    // Documents of the next few required assets are requested while the current one is
    // examined (the loader caps how many read at once). They are consumed in `order`, so
    // fonts, revision checks and the first error follow the sequence of a serial pass.
    const readDocument = createReadAhead(READ_AHEAD, async (guid: string): Promise<RegistryLoadedAsset> => {
      // The catalog closure above has just been refreshed; the prepared result is validated before publication.
      const override = host.documentOverrides?.get(guid);
      const header = host.registry.getByGuid(guid)!.header;
      return override ? {
        revision: catalogRevisions.get(guid)!, chunks: new Map(),
        document: { guid, type: header.type, name: header.name, version: header.version, payload: override.payload },
      } : await scope.acquire<RegistryLoadedAsset>(guid, undefined, { signal: options.signal, priority: options.priority, dependencies: "none", refresh: false });
    });
    for (let index = 0; index < order.length; index++) {
      const guid = order[index]!;
      const value = await readDocument(order, index);
      if (value.revision !== catalogRevisions.get(guid)) throw new SourceRevisionChangedError(`Asset ${guid} changed after resolving its dependencies; retry`);
      documents.set(guid, value);
      const payload = value.document.payload;
      const actors = Array.isArray(payload.actors) ? payload.actors as Array<{ components?: unknown[] }> : [];
      const components = [
        ...(Array.isArray(payload.components) ? payload.components : []),
        ...actors.flatMap((actor) => actor.components ?? []),
      ] as Array<{ classId?: string; properties?: Record<string, unknown> }>;
      for (const component of components) {
        if (component.classId === "Text3DComponent") {
          const guid = component.properties?.fontAssetGuid;
          if (typeof guid === "string") await requireFont(guid, [FONT_FACETYPE_CHUNK_ID]);
        } else if (component.classId === "2DTextComponent" || component.classId === "2DRichTextComponent") {
          const text = parseText2DProperties(component.properties);
          await requireFont(text.fontAssetGuid ?? project.settings.fonts.defaultFontGuid,
            text.renderer === "msdf" ? [FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID] : ["source"]);
        }
      }
    }
    game.manifest.assets = [...required].map((guid) => { const { header } = host.registry.getByGuid(guid)!; return {
      guid, type: header.type, name: header.name, encoding: "json" as const,
      width: Number(header.payload.width), height: Number(header.payload.height),
    }; });
    // Font fallback assets inherit the representation used by their consumer.
    const visitFallbacks = (guid: string, chunks: ReadonlySet<string>, seen = new Set<string>()) => {
      if (seen.has(guid)) return;
      seen.add(guid);
      const value = documents.get(guid);
      if (!value) return;
      for (const fallback of normalizeFontPayload(value.document.payload, value.document.name).fallbackGuids) {
        const modes = fontModes.get(fallback) ?? new Set<string>();
        for (const chunk of chunks) modes.add(chunk);
        fontModes.set(fallback, modes);
        visitFallbacks(fallback, modes, seen);
      }
    };
    for (const [guid, modes] of fontModes) visitFallbacks(guid, modes);
    const emissions = new Set(areaEmissionTextureGuids([...documents.values()].map((value) => value.document.payload)));
    const complexCollisionGuids = complexCollisionModelGuids([...documents.values()].map((value) => value.document.payload));
    let completed = 0;
    let sourceBytes = 0;
    let documentBytes = 0;
    const revisions: Array<[string, string]> = [];
    // Source chunks of the next few assets are requested while the current one is applied
    // (the loader caps how many read at once). Their results are consumed in `order`, so the
    // game containers fill in the same sequence and the first failure is the one a serial pass reports.
    const readChunks = createReadAhead(READ_AHEAD, async (guid: string): Promise<Map<string, Uint8Array>> => {
      const asset = host.registry.getByGuid(guid)!;
      const preparedDocument = documents.get(guid)!;
      if (asset.locator?.revision !== preparedDocument.revision) throw new SourceRevisionChangedError(`Asset ${guid} changed after its document loaded; retry`);
      const chunkIds = selectedChunks(asset, preparedDocument.document.payload, fontModes, emissions);
      // A chunk stays compatible when another consumer asks for additional
      // variants (for example the same Texture used by a material and a light).
      const requests = chunkIds.map((chunkId) => {
        const request = (async () => {
          const representation = await registryAssetRepresentation(host.registry, guid, {
            selectChunks: () => [chunkId], includeDocument: false, representationKey: "runtime-source-chunk",
          }, { signal: options.signal }, false);
          return scope.acquire<RegistryLoadedAsset>(guid, representation, { signal: options.signal, priority: options.priority, dependencies: "none", refresh: false });
        })();
        // Awaited in chunk order below; a later chunk's failure is moot when an earlier one fails.
        request.catch(() => undefined);
        return request;
      });
      const chunks = new Map<string, Uint8Array>();
      for (const [position, request] of requests.entries()) {
        const loaded = await request;
        if (loaded.revision !== preparedDocument.revision) throw new SourceRevisionChangedError(`Asset ${guid} changed while selecting source data; retry`);
        chunks.set(chunkIds[position]!, loaded.chunks.get(chunkIds[position]!)!);
      }
      return chunks;
    });
    for (let index = 0; index < order.length; index++) {
      const guid = order[index]!;
      options.signal.throwIfAborted();
      const asset = host.registry.getByGuid(guid)!;
      const preparedDocument = documents.get(guid)!;
      const document = preparedDocument.document;
      // Storage is validated again before the prepared content is published.
      if (asset.locator?.revision !== preparedDocument.revision) throw new SourceRevisionChangedError(`Asset ${guid} changed after its document loaded; retry`);
      const chunks = await readChunks(order, index);
      const value = { ...preparedDocument, chunks };
      sourceBytes += [...value.chunks.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
      documentBytes += documentByteEstimate(host, guid, document.payload);
      revisions.push([guid, preparedDocument.revision]);
      const { type, payload } = document;
      (game.decodedPayloads as Map<string, unknown>).set(guid, payload);
      if (type === "Scene") game.scenes.set(guid, normalizeScene(payload));
      else if (type === "SceneLayer") game.sceneLayers.set(guid, normalizeSceneLayer(payload));
      else if (type === "Texture") game.textureBytes.set(guid, value.chunks.get(selectTextureChunk(asset.header).chunk.id)!);
      else if (type === "Model") {
        const source = value.chunks.get("source");
        if (source) game.modelBytes.set(guid, source);
        const model = normalizeModelPayload(payload);
        game.modelPayloads.set(guid, model);
        // Only Models a Scene/Class in this closure simulates with Complex Collision are cooked up front.
        if (source && complexCollisionGuids.has(guid)) {
          const mesh = await cookModelCollision(guid, source, model, options.signal);
          if (mesh) complexMeshes.set(guid, mesh);
        }
      } else if (type === "Audio") {
        const audio = normalizeAudioPayload(payload);
        game.audioPayloads.set(guid, audio);
        const clips = new Map(audio.clips.map((clip) => [clip.chunkId, value.chunks.get(clip.chunkId)!]));
        audioChunks.set(guid, clips);
        audioRevisions.set(guid, JSON.stringify([preparedDocument.revision,
          audio.clips.map((clip) => [clip.chunkId, asset.header.chunks.find((entry) => entry.id === clip.chunkId)?.sha256])]));
        const source = clips.get(AUDIO_DEFAULT_SOURCE_CHUNK) ?? clips.values().next().value;
        if (source) game.audioBytes.set(guid, source);
      } else if (type === "Font") {
        const font = normalizeFontPayload(payload, asset.header.name);
        game.fontFamilies.set(guid, font.family);
        for (const [id, map] of [["source", game.fontBytes], [FONT_FACETYPE_CHUNK_ID, game.fontFacetypeBytes], [FONT_MSDF_CHUNK_ID, game.fontMsdfJson], [FONT_MSDF_PNG_CHUNK_ID, game.fontMsdfPng]] as const) {
          const bytes = value.chunks.get(id);
          if (bytes) map.set(guid, bytes);
        }
      }
      if (type === "Texture" && emissions.has(guid)) {
        const entry = currentAreaEmissionChunk(asset.header)!;
        const bytes = value.chunks.get(entry.id)!;
        const decoded = await scope.acquire(guid, {
          key: `area-emission:${entry.sha256}`,
          estimate: { sourceBytes: 0, decodedBytes: bytes.byteLength, temporaryBytes: bytes.byteLength },
          load: async () => ({ value: await decodeAreaEmission(bytes), sourceBytes: 0, decodedBytes: bytes.byteLength }),
        }, { signal: options.signal, priority: options.priority, dependencies: "none", refresh: false });
        game.areaEmissions.set(guid, decoded);
      }
      const navmesh = value.chunks.get("navmesh");
      if (navmesh) game.navmeshBytes.set(guid, navmesh);
      const reverb = value.chunks.get("audioReverb");
      if (reverb) game.audioReverbBytes.set(guid, reverb);
      options.onProgress?.({ completed: ++completed, total: required.size });
    }
    const root = roots[0] ?? required.values().next().value;
    const compileInputs = revisions.filter(([guid]) => COMPILE_INPUT_TYPES.has(host.registry.getByGuid(guid)!.header.type))
      .sort(([a], [b]) => a.localeCompare(b));
    // A Scene's SceneScript and a Scene Layer's SceneLayerScript compile too; their
    // scripts, not the whole Scene revisions, key the compile.
    // The script with what its Get <Actor>, Get <Component> and Get <Timeline Clip> nodes are checked against.
    const embeddedScripts = revisions
      .filter(([guid]) => EMBEDDED_SCRIPT_OWNER_TYPES.has(host.registry.getByGuid(guid)!.header.type))
      .flatMap(([guid]) => {
        const payload = documents.get(guid)!.document.payload as EmbeddedScriptOwner;
        const scene = payload as Partial<Pick<SerializedScene, "actors" | "timelineClips">>;
        return payload.script ? [[guid, payload.script, ownedActorsOfScene({ actors: Array.isArray(scene.actors) ? scene.actors : [] }),
          ownedTimelineClipsOfScene(guid, { timelineClips: Array.isArray(scene.timelineClips) ? scene.timelineClips : [] })] as const] : [];
      })
      .sort(([a], [b]) => a.localeCompare(b));
    const compileRoot = compileInputs.find(([guid]) => SCRIPT_ASSET_TYPES.has(host.registry.getByGuid(guid)!.header.type))?.[0] ??
      embeddedScripts[0]?.[0] ?? root;
    const compileInputBytes = compileInputs.reduce((total, [guid]) => total + documentByteEstimate(host, guid, documents.get(guid)!.document.payload) * 2, 0);
    // Working documents of the closure: their identity, since their payload replaces the stored revision.
    const workingInputs = [...required].flatMap((guid) => {
      const override = host.documentOverrides?.get(guid);
      return override ? [[guid, override.cacheKey]] : [];
    }).sort(([a], [b]) => a.localeCompare(b));
    // What the compile reads: the closure's compile inputs and embedded scripts, and the project-wide catalog
    // (which carries the working documents among its assets). Scene edits outside scripts keep the entry.
    const compiled = compileRoot ? await scope.acquire(compileRoot, {
      key: `play-scripts:v2:${JSON.stringify([compileInputs, embeddedScripts])}:${playCompileCatalogKey(host)}:${JSON.stringify([
        project.settings.tags, project.settings.infiniteLoopDetection, project.settings.loopCount,
        host.traceExecution === true])}`,
      estimate: { sourceBytes: 0, decodedBytes: Math.max(4096, compileInputBytes * 8), temporaryBytes: Math.max(4096, compileInputBytes * 4) },
      load: async (_asset, signal) => {
        signal.throwIfAborted();
        // The stored documents read above: the compile does not read its closed Classes and Scenes again.
        const stored = new Map([...documents].filter(([guid]) => !host.documentOverrides?.has(guid))
          .map(([guid, value]) => [guid, { type: value.document.type, version: value.document.version, payload: value.document.payload }]));
        const result = await host.compile(required, stored);
        signal.throwIfAborted();
        // Prepared content validates every input against storage before publication.
        for (const [guid, revision] of compileInputs) {
          if (host.registry.getByGuid(guid)?.locator?.revision !== revision) throw new SourceRevisionChangedError(`Class compilation input ${guid} changed; retry`);
        }
        const byPath = new Map(host.registry.list().map(asset => [asset.path, asset]));
        const bundles = result.bundles.map(script => {
          const owner = host.registry.getByGuid(script.assetGuid) ?? byPath.get(script.assetGuid);
          if (!owner) throw new Error(`Compiled Class ${script.classId} has no catalog asset for ${script.assetGuid}`);
          return {
            ...script,
            assetGuid: owner.header.guid,
          };
        });
        const value = { bundles, diagnostics: [...result.diagnostics] };
        return {
          value, sourceBytes: 0, decodedBytes: JSON.stringify(value).length * 2,
          dispose: () => { value.bundles.length = 0; value.diagnostics.length = 0; },
        };
      },
    }, { signal: options.signal, priority: options.priority, dependencies: "none", refresh: false }) : { bundles: [], diagnostics: [] };
    const failure = compiled.diagnostics.find((entry) => entry.severity === "error");
    if (failure && !options.allowCompileErrors) throw new Error(failure.message);
    game.scripts = compiled.bundles;
    options.signal.throwIfAborted();
    const cpuBytes = documentBytes * 8;
    const cachedContent = root ? await scope.acquire(root, {
      key: `play-content:metadata-v2:${JSON.stringify([revisions.sort(([a], [b]) => a.localeCompare(b)), workingInputs, [...fontModes].sort(([a], [b]) => a.localeCompare(b)).map(([guid, modes]) => [guid, [...modes].sort()]), project.settings.fonts, project.settings.twoD, project.settings.audio.audioMixerGuid])}`,
      estimate: { sourceBytes: 0, decodedBytes: cpuBytes, temporaryBytes: sourceBytes },
      load: async (_asset, signal) => {
        signal.throwIfAborted();
        // Baked bytes and collision arrays already belong to separate cache
        // entries. A metadata cache entry must never prolong their residency.
        const value = packedContentFromGame({ ...game, navmeshBytes: new Map(), audioReverbBytes: new Map(), complexMeshes: new Map() });
        value.audioLibrary.sourceRevisions = new Map(audioRevisions);
        return { value, sourceBytes: 0, decodedBytes: cpuBytes, dispose: () => releasePackedContent(value) };
      },
    }, { signal: options.signal, priority: options.priority, dependencies: "none", refresh: false }) : packedContentFromGame(game);
    // Each asset was read, or its catalog checked against storage, at its revision during this acquisition (or
    // earlier in the session, when trusted). The registry indexes every save, encode and bake, so one that landed
    // since shows here without reading storage again; the first in `revisions` order is reported.
    for (const [guid, revision] of revisions) {
      const current = host.registry.getByGuid(guid)?.locator?.revision;
      if (current !== revision) throw new SourceRevisionChangedError(`Asset ${guid} changed during runtime preparation; retry. Expected source revision ${revision}; found ${current ?? "none"}`);
    }
    const content = copyContainers(cachedContent);
    content.audioLibrary = copyContainers(cachedContent.audioLibrary);
    content.particleLibrary = copyContainers(cachedContent.particleLibrary);
    content.navmeshByScene = game.navmeshBytes;
    content.navmeshBytes = game.navmeshBytes.get(game.manifest.startupSceneGuid) ?? null;
    content.audioReverbByScene = game.audioReverbBytes;
    content.audioReverbBytes = game.audioReverbBytes.get(game.manifest.startupSceneGuid) ?? null;
    content.complexMeshes = complexMeshes;
    ownedContent = content;
    for (const [guid, bytes] of game.fontBytes) {
      if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error(`Font ${guid}: storage returned an unsupported shared source buffer`);
      fonts.push({ guid, family: game.fontFamilies.get(guid) ?? guid,
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
    }
    const sources: SceneSourceAssets = {
      assets: {
        modelBytes: game.modelBytes, modelPayloads: content.modelPayloads,
        modelClipAnimationGuids: content.modelClipAnimationGuids, retargetAnimationLoads: content.retargetAnimationLoads,
        textureBytes: game.textureBytes, texturePixelSizes: content.texturePixelSizes, areaEmissions: game.areaEmissions,
        spritePayloads: content.spritePayloads, spriteAnimations: content.spriteAnimationPayloads,
        tilemaps: content.tilemapPayloads, tilesets: content.tilesetPayloads, waters: content.waterPayloads,
        renderTargets: content.renderTargets, renderTargetTextures: content.renderTargetTextures,
        fontFacetypeBytes: game.fontFacetypeBytes, fontMsdfJson: game.fontMsdfJson, fontMsdfPng: game.fontMsdfPng,
        ...playText2DFontStacks(host, game.fontFamilies),
        pixelsPerUnit: content.pixelsPerUnit, sortingLayers: content.sortingLayers,
      },
      materialDocuments: content.materialDocuments, materialFunctions: content.materialFunctions,
      particleLibrary: content.particleLibrary, audioLibrary: content.audioLibrary,
      fonts,
      // What its Classes may spawn, and the generic kinds when it may spawn a Class it does not hold (a Load On Demand one).
      spawnableLights: spawnableLightsOfLoad({
        scripts: game.scripts, assets: [...required].map((guid) => ({ guid, dependencies: host.registry.dependenciesFor(guid) })),
        isClass: (guid) => host.registry.getByGuid(guid)?.header.type === "Class",
      }),
    };
    controls.push(...packedPlayControls(content).filter((control) => control.type !== "loadNavMesh"));
    if (game.scripts.length) controls.unshift({ type: "loadScripts", scripts: game.scripts });
    /** On-demand fallback for a Model the content scan did not mark (for example a script switching Collision Mode). */
    const cookComplexCollision = async (guid: string): Promise<CollisionTriangleMesh | null> => {
      const source = released ? undefined : game.modelBytes.get(guid);
      if (!source) return null;
      return cookModelCollision(guid, source, game.modelPayloads.get(guid) ?? normalizeModelPayload({}), options.signal);
    };
    return { game, content, sources, controls, required, audioChunks, diagnostics: compiled.diagnostics, release, cookComplexCollision };
  } catch (error) {
    release();
    throw new Error(`Asset preparation for ${options.consumer} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Bitmap 2D Text stacks for every project Font, as the Scene Viewport and the exported player compile them:
 * the Font, its fallbacks, the project default Font, then the global fallback. Engine source unions keep the
 * last acquisition's default stack, so each acquisition publishes the whole project's stacks. A prepared
 * Font's family is the one its FontFace registers under.
 */
function playText2DFontStacks(host: PlayAssetSourceHost, preparedFamilies: ReadonlyMap<string, string>) {
  const fonts = host.registry.list({ type: "Font" }).map((asset) => {
    const guid = asset.header.guid;
    const payload = normalizeFontPayload(host.documentOverrides?.get(guid)?.payload ?? asset.header.payload, asset.header.name);
    return { guid, family: preparedFamilies.get(guid) ?? payload.family, fallbackGuids: payload.fallbackGuids };
  });
  const compiled = compileText2DFontStacks({
    fonts, defaultFontGuid: host.project.settings.fonts.defaultFontGuid, globalFallback: host.project.settings.fonts.globalFallback,
  });
  return { fontCssStack: compiled.defaultStack, fontCssStackByGuid: compiled.byGuid };
}

const SCRIPT_ASSET_TYPES = new Set(["Class", "AnimationGraph"]);
/** Assets that may embed a script (SceneScript, SceneLayerScript). */
const EMBEDDED_SCRIPT_OWNER_TYPES = new Set(["Scene", "SceneLayer"]);
const COMPILE_INPUT_TYPES = new Set([...SCRIPT_ASSET_TYPES, "InputAction", "InputAxis", "DataDefinition", "DataTree", "Enum", "Structure", "ScriptInterface"]);
/**
 * Assets the Play compile reads project-wide, beyond its closure: class lineage and palette, the typed
 * catalogs, Material domains, and the Timelines with their clip assets.
 */
const COMPILE_CATALOG_TYPES = new Set([...COMPILE_INPUT_TYPES, "Material", "MaterialInstance", "Timeline", "TimelineClip2D", "TimelineClip3D"]);

type EmbeddedScriptOwner = { script?: unknown; actors?: unknown; timelineClips?: unknown };

const compileCatalogKeys = new WeakMap<PlayAssetSourceHost, { generation: number; key: string }>();

/** `playCompileCatalog` as a cache key, built once per host while the registry's catalog stays unchanged. */
function playCompileCatalogKey(host: PlayAssetSourceHost): string {
  const { generation } = host.registry;
  const memo = compileCatalogKeys.get(host);
  if (memo && memo.generation === generation) return memo.key;
  const key = JSON.stringify(playCompileCatalog(host));
  if (typeof generation === "number") compileCatalogKeys.set(host, { generation, key });
  return key;
}

/**
 * What the Play compile reads across the project: each catalog asset's identity and current revision
 * (or its working document), and each Scene's and Scene Layer's identity and Timeline Clips. Other
 * header changes (texture encodes, imports) and Scene edits that leave the clips alone keep compiled
 * scripts cached; the closure's own documents are keyed separately.
 */
function playCompileCatalog(host: PlayAssetSourceHost): unknown[] {
  return host.registry.list().flatMap((asset): unknown[] => {
    const { guid, type, name } = asset.header;
    const override = host.documentOverrides?.get(guid);
    if (EMBEDDED_SCRIPT_OWNER_TYPES.has(type)) {
      const clips = override ? timelineClipSummaries((override.payload as EmbeddedScriptOwner).timelineClips as SerializedScene["timelineClips"])
        : readTimelineClipSummaries(asset.header.payload);
      return [[guid, asset.path, type, name, clips]];
    }
    if (!COMPILE_CATALOG_TYPES.has(type)) return [];
    const revision = override?.cacheKey ?? asset.locator?.revision ?? JSON.stringify(asset.header.payload ?? null);
    return [[guid, asset.path, type, name, asset.header.parentClass ?? null, revision]];
  });
}

/** Drop cache-owned containers without mutating authored payload objects. */
function releasePackedContent(content: PackedGameContent): void {
  const record = content as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value instanceof Map) value.clear();
    else if (Array.isArray(value)) record[key] = [];
  }
  for (const value of Object.values(content.audioLibrary)) if (value instanceof Map) value.clear();
  for (const value of Object.values(content.particleLibrary)) if (value instanceof Map) value.clear();
  content.navmeshBytes = null;
  content.audioReverbBytes = null;
}

export type PreparedPlaySources = Awaited<ReturnType<typeof acquirePlayAssetSources>>;

/** Rebuild only container unions; retained collision/animation results are reused. */
export function mergePreparedPlaySources(entries: Iterable<PreparedPlaySources>) {
  const prepared = [...entries];
  if (!prepared.length) return null;
  const first = prepared[0];
  const game = copyContainers(first.game);
  // The manifest's asset list (for example the Audio GUIDs Play Sound accepts) is a union too.
  game.manifest = copyContainers(first.game.manifest);
  const content = copyContainers(first.content);
  content.audioLibrary = copyContainers(first.content.audioLibrary);
  content.particleLibrary = copyContainers(first.content.particleLibrary);
  const rest = prepared.slice(1);
  mergeContainers(game, rest.map((next) => next.game));
  mergeContainers(game.manifest, rest.map((next) => next.game.manifest));
  mergeContainers(content, rest.map((next) => next.content));
  mergeContainers(content.audioLibrary, rest.map((next) => next.content.audioLibrary));
  mergeContainers(content.particleLibrary, rest.map((next) => next.content.particleLibrary));
  const controls = packedSourceControls(game, content);
  return { game, content, controls };
}

/**
 * Merged source controls for the live preparations, rebuilt only when the set of
 * preparations changes. Prepared content is immutable once acquired, so membership
 * identifies the result. `reset` drops the retained union at session end.
 */
export function createMergedPlaySourceControls(entries: () => Iterable<PreparedPlaySources>): {
  (): ControlMessage[];
  reset(): void;
} {
  let members: PreparedPlaySources[] = [];
  let merged: ControlMessage[] | null = null;
  const get = () => {
    const current = [...entries()];
    if (merged && current.length === members.length && current.every((entry, index) => entry === members[index])) return merged;
    members = current;
    merged = mergePreparedPlaySources(current)?.controls ?? emptyPlaySourceControls();
    return merged;
  };
  get.reset = () => { members = []; merged = null; };
  return get;
}

export function emptyPlaySourceControls(): ControlMessage[] {
  return [
    { type: "loadScripts", scripts: [], spawn: [], replace: true },
    { type: "loadSceneContent", assetGuids: [] },
    { type: "loadModels", models: [], complexMeshes: [] },
    { type: "loadSprites", sprites: [], spriteAnimations: [] },
    { type: "loadTilemaps", tilemaps: [], tilesets: [] },
    { type: "loadWater", waters: [] },
    { type: "loadAnimGraphs", graphs: [] },
    { type: "loadBehaviourTrees", trees: [], blackboards: [] },
  ];
}

function copyContainers<T extends object>(source: T): T {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key,
    value instanceof Map ? new Map(value) : Array.isArray(value) ? [...value] : value,
  ])) as T;
}

/**
 * Union `sources` into `target` in one pass. Maps take the last value per id; GUID- or
 * class-keyed arrays take the last entry per key at the key's first position.
 */
function mergeContainers(target: object, sources: readonly object[]): void {
  const merged = target as Record<string, unknown>;
  const keyed = new Map<string, Map<unknown, unknown>>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const current = merged[key];
      if (current instanceof Map && value instanceof Map) {
        for (const [id, entry] of value) current.set(id, entry);
      } else if (Array.isArray(current) && Array.isArray(value) && value.length
        && typeof value[0] === "object" && value[0] !== null && ("guid" in value[0] || "classId" in value[0])) {
        let entries = keyed.get(key);
        if (!entries) keyed.set(key, entries = new Map(current.map(keyedEntry)));
        for (const entry of value) { const [id, item] = keyedEntry(entry); entries.set(id, item); }
      }
    }
  }
  for (const [key, entries] of keyed) merged[key] = [...entries.values()];
}

function keyedEntry(entry: { guid?: string; classId?: string }): [unknown, unknown] {
  return [entry.guid ?? entry.classId, entry];
}
