import { areaEmissionTextureGuids, normalizeScene, normalizeSceneLayer, parseText2DProperties, renderEffectsAssetGuids, type ProjectDocument } from "@babylonslate/core";
import {
  AUDIO_DEFAULT_SOURCE_CHUNK, FONT_FACETYPE_CHUNK_ID, FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID,
  cookComplexCollisionMeshes, currentAreaEmissionChunk, decodeAreaEmission, getRequiredDependencies, modelAnimationDurations, normalizeAudioPayload, normalizeFontPayload, normalizeModelPayload,
  registryAssetRepresentation, selectTextureChunk, type AssetLoadScope, type AssetRegistry,
  type IndexedAsset, type RegistryLoadedAsset,
} from "@babylonslate/assets";
import { packedContentFromGame, packedPlayControls, packedSourceControls, type GameSourceContent, type PackedGameContent } from "@babylonslate/exporter";
import type { SceneSourceAssets } from "@babylonslate/render";
import type { ControlMessage, ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";

export interface PlayAssetSourceHost {
  registry: AssetRegistry;
  project: ProjectDocument;
  createScope: (owner: string) => AssetLoadScope;
  compile: (required: ReadonlySet<string>) => Promise<{ bundles: ScriptBundleEntry[]; diagnostics: readonly Diagnostic[] }>;
}

/** Catalog closure only. A SceneStreamingComponent's target is a deferred edge. */
export function requiredPlayAssets(registry: AssetRegistry, roots: readonly string[]): Set<string> {
  const result = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const guid = pending.pop()!;
    if (result.has(guid)) continue;
    const asset = registry.getByGuid(guid);
    if (!asset || asset.placeholder) throw new Error(`Required asset is missing: ${guid}`);
    result.add(guid);
    pending.push(...getRequiredDependencies(asset.header));
  }
  return result;
}

export function requiredProjectAssets(registry: AssetRegistry, project: ProjectDocument): string[] {
  const settings = project.settings;
  const roots = [settings.audio.audioMixerGuid, ...renderEffectsAssetGuids(settings.render.effects)];
  const classId = settings.gameInstanceClass;
  const asset = classId ? registry.list().find(({ header }) => header.guid === classId || `scene:${header.guid}` === classId) : undefined;
  if (asset) roots.push(asset.header.guid);
  return roots.filter((guid): guid is string => Boolean(guid));
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

/** A shared preparation contract for initial Play, streamed Scenes and explicit preloads. */
export async function acquirePlayAssetSources(
  host: PlayAssetSourceHost,
  roots: readonly string[],
  options: { consumer: string; signal: AbortSignal; onProgress?: (progress: { completed: number; total: number }) => void; allowCompileErrors?: boolean },
) {
  const required = requiredPlayAssets(host.registry, roots);
  const scope = host.createScope(options.consumer);
  const project = host.project;
  const audioChunks = new Map<string, Map<string, Uint8Array>>();
  const audioRevisions = new Map<string, string>();
  const complexMeshes: PackedGameContent["complexMeshes"] = new Map();
  const durations = new Map<string, ReadonlyMap<string, number | undefined>>();
  const game: GameSourceContent = {
    manifest: {
      assetCatalogVersion: 1, startupSceneGuid: roots.find((id) => host.registry.getByGuid(id)?.header.type === "Scene") ?? "",
      bundleDebugger: true, mode: "loose", render: project.settings.render, playFrameCap: project.settings.playFrameCap,
      pixelsPerUnit: project.settings.twoD.pixelsPerUnit, sortingLayers: project.settings.twoD.sortingLayers,
      pixelPerfect: project.settings.twoD.pixelPerfect, packs: [], scriptsFile: "", physicsWorld: "3d",
      audioMixerGuid: project.settings.audio.audioMixerGuid ?? undefined,
      assets: [...required].map((guid) => { const { header } = host.registry.getByGuid(guid)!; return {
        guid, type: header.type, name: header.name, encoding: "json" as const,
        width: Number(header.payload.width), height: Number(header.payload.height),
      }; }),
    },
    scripts: [], scenes: new Map(), sceneLayers: new Map(), textureBytes: new Map(), areaEmissions: new Map(),
    modelBytes: new Map(), modelPayloads: new Map(), fontBytes: new Map(), fontFacetypeBytes: new Map(),
    fontMsdfJson: new Map(), fontMsdfPng: new Map(), fontFamilies: new Map(), audioBytes: new Map(),
    audioPayloads: new Map(), payloads: new Map(), decodedPayloads: new Map(), navmeshBytes: new Map(), audioReverbBytes: new Map(),
    complexMeshes, modelAnimationDurations: durations,
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scope.dispose();
    audioChunks.clear();
    audioRevisions.clear();
    for (const value of Object.values(game)) if (value instanceof Map) value.clear();
  };
  try {
    // First read authored documents to select the exact binary representations.
    const documents = new Map<string, RegistryLoadedAsset>();
    const fontModes = new Map<string, Set<string>>();
    const requireFont = (guid: string | null | undefined, chunks: readonly string[]) => {
      if (!guid) return;
      const modes = fontModes.get(guid) ?? new Set<string>();
      for (const chunk of chunks) modes.add(chunk);
      fontModes.set(guid, modes);
      for (const dependency of requiredPlayAssets(host.registry, [guid])) required.add(dependency);
    };
    for (const guid of required) {
      const value = await scope.acquire<RegistryLoadedAsset>(guid, undefined, { signal: options.signal, dependencies: "none" });
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
          if (typeof guid === "string") requireFont(guid, [FONT_FACETYPE_CHUNK_ID]);
        } else if (component.classId === "2DTextComponent" || component.classId === "2DRichTextComponent") {
          const text = parseText2DProperties(component.properties);
          requireFont(text.fontAssetGuid ?? project.settings.fonts.defaultFontGuid,
            text.renderer === "msdf" ? [FONT_MSDF_CHUNK_ID, FONT_MSDF_PNG_CHUNK_ID] : ["source"]);
        }
      }
    }
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
    let completed = 0;
    let sourceBytes = 0;
    let documentBytes = 0;
    const revisions: Array<[string, string]> = [];
    for (const guid of required) {
      options.signal.throwIfAborted();
      const asset = host.registry.getByGuid(guid)!;
      const preparedDocument = documents.get(guid)!;
      const document = preparedDocument.document;
      if ((await host.registry.getAssetLocator(guid)).revision !== preparedDocument.revision) throw new Error(`Asset ${guid} changed after its document loaded; retry`);
      const chunkIds = selectedChunks(asset, document.payload, fontModes, emissions);
      const chunks = new Map<string, Uint8Array>();
      // A chunk stays compatible when another consumer asks for additional
      // variants (for example the same Texture used by a material and a light).
      for (const chunkId of chunkIds) {
        const representation = await registryAssetRepresentation(host.registry, guid, {
          selectChunks: () => [chunkId], includeDocument: false, representationKey: "runtime-source-chunk",
        });
        const loaded = await scope.acquire<RegistryLoadedAsset>(guid, representation, { signal: options.signal, dependencies: "none" });
        if (loaded.revision !== preparedDocument.revision) throw new Error(`Asset ${guid} changed while selecting source data; retry`);
        chunks.set(chunkId, loaded.chunks.get(chunkId)!);
      }
      const value = { ...preparedDocument, chunks };
      sourceBytes += [...value.chunks.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
      documentBytes += new TextEncoder().encode(JSON.stringify(document.payload)).byteLength;
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
        if (source) {
          const prepared = await scope.acquire(guid, {
            key: "model-cpu:collision-and-clips-v1",
            estimate: { sourceBytes: 0, decodedBytes: source.byteLength * 4, temporaryBytes: source.byteLength * 2 },
            load: async (_asset, signal) => {
              signal.throwIfAborted();
              const meshes = cookComplexCollisionMeshes(new Map([[guid, source]]), new Map([[guid, model]]));
              const clips = modelAnimationDurations(source);
              const mesh = meshes.get(guid);
              const decodedBytes = (mesh ? mesh.vertices.length * 32 + mesh.indices.length * 8 : 0) + clips.size * 128;
              return {
                value: { meshes, clips }, sourceBytes: 0, decodedBytes,
                dispose: () => { meshes.clear(); clips.clear(); },
              };
            },
          }, { signal: options.signal, dependencies: "none" });
          for (const [id, mesh] of prepared.meshes) complexMeshes.set(id, mesh);
          durations.set(guid, prepared.clips);
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
        }, { signal: options.signal, dependencies: "none" });
        game.areaEmissions.set(guid, decoded);
      }
      const navmesh = value.chunks.get("navmesh");
      if (navmesh) game.navmeshBytes.set(guid, navmesh);
      const reverb = value.chunks.get("audioReverb");
      if (reverb) game.audioReverbBytes.set(guid, reverb);
      options.onProgress?.({ completed: ++completed, total: required.size });
    }
    const compiled = await host.compile(required);
    const failure = compiled.diagnostics.find((entry) => entry.severity === "error");
    if (failure && !options.allowCompileErrors) throw new Error(failure.message);
    game.scripts = compiled.bundles;
    options.signal.throwIfAborted();
    const root = roots[0];
    if (!root) throw new Error("Asset preparation requires at least one root asset");
    const cpuBytes = documentBytes * 8;
    const content = await scope.acquire(root, {
      key: `play-content:${JSON.stringify([revisions.sort(([a], [b]) => a.localeCompare(b)), project.settings.fonts, project.settings.twoD, project.settings.audio.audioMixerGuid])}`,
      estimate: { sourceBytes: 0, decodedBytes: cpuBytes, temporaryBytes: sourceBytes },
      load: async (_asset, signal) => {
        signal.throwIfAborted();
        const value = packedContentFromGame(game);
        value.audioLibrary.sourceRevisions = new Map(audioRevisions);
        for (const [guid, revision] of revisions) {
          if ((await host.registry.getAssetLocator(guid)).revision !== revision) throw new Error(`Asset ${guid} changed during runtime preparation; retry`);
        }
        return { value, sourceBytes: 0, decodedBytes: cpuBytes, dispose: () => releasePackedContent(value) };
      },
    }, { signal: options.signal, dependencies: "none" });
    const sources: SceneSourceAssets = {
      assets: {
        modelBytes: game.modelBytes, modelPayloads: content.modelPayloads,
        modelClipAnimationGuids: content.modelClipAnimationGuids, retargetAnimationLoads: content.retargetAnimationLoads,
        textureBytes: game.textureBytes, texturePixelSizes: content.texturePixelSizes, areaEmissions: game.areaEmissions,
        spritePayloads: content.spritePayloads, spriteAnimations: content.spriteAnimationPayloads,
        tilemaps: content.tilemapPayloads, tilesets: content.tilesetPayloads, waters: content.waterPayloads,
        renderTargets: content.renderTargets, renderTargetTextures: content.renderTargetTextures,
        fontFacetypeBytes: game.fontFacetypeBytes, fontMsdfJson: game.fontMsdfJson, fontMsdfPng: game.fontMsdfPng,
        fontCssStackByGuid: new Map([...game.fontFamilies].map(([id, family]) => [id, `"${family}", ${project.settings.fonts.globalFallback}`])),
        fontCssStack: project.settings.fonts.globalFallback,
        pixelsPerUnit: content.pixelsPerUnit, sortingLayers: content.sortingLayers,
      },
      materialDocuments: content.materialDocuments, materialFunctions: content.materialFunctions,
      particleLibrary: content.particleLibrary, audioLibrary: content.audioLibrary,
      fonts: [...game.fontBytes].map(([guid, bytes]) => ({ guid, family: game.fontFamilies.get(guid) ?? guid, bytes: bytes.slice().buffer })),
    };
    const controls = packedPlayControls(content).filter((control) => control.type !== "loadNavMesh");
    if (game.scripts.length) controls.unshift({ type: "loadScripts", scripts: game.scripts });
    return { game, content, sources, controls, required, audioChunks, diagnostics: compiled.diagnostics, release };
  } catch (error) {
    release();
    throw new Error(`Asset preparation for ${options.consumer} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
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

type PreparedPlaySources = Awaited<ReturnType<typeof acquirePlayAssetSources>>;

/** Rebuild only container unions; retained collision/animation results are reused. */
export function mergePreparedPlaySources(entries: Iterable<PreparedPlaySources>) {
  const prepared = [...entries];
  if (!prepared.length) return null;
  const first = prepared[0];
  const game = copyContainers(first.game);
  const content = copyContainers(first.content);
  content.audioLibrary = copyContainers(first.content.audioLibrary);
  content.particleLibrary = copyContainers(first.content.particleLibrary);
  for (const next of prepared.slice(1)) {
    mergeContainers(game, next.game);
    mergeContainers(content, next.content);
    mergeContainers(content.audioLibrary, next.content.audioLibrary);
    mergeContainers(content.particleLibrary, next.content.particleLibrary);
  }
  const controls = packedSourceControls(game, content);
  if (game.scripts.length) controls.unshift({ type: "loadScripts", scripts: game.scripts });
  return { game, content, controls };
}

export function emptyPlaySourceControls(): ControlMessage[] {
  return [
    { type: "loadScripts", scripts: [] },
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

function mergeContainers(target: object, source: object): void {
  const merged = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    if (current instanceof Map && value instanceof Map) {
      for (const [id, entry] of value) current.set(id, entry);
    } else if (Array.isArray(current) && Array.isArray(value) && value.length
      && typeof value[0] === "object" && value[0] !== null && ("guid" in value[0] || "classId" in value[0])) {
      merged[key] = [...new Map([...current, ...value].map((entry: { guid?: string; classId?: string }) => [entry.guid ?? entry.classId, entry])).values()];
    }
  }
}
