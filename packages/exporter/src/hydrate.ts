import type { CameraShakeCatalogEntry, CurveAssetCatalogEntry, DataAssetCatalogEntry, GlobalParameterCatalog, TimelineClipAssetCatalogEntry } from "@haptic/core";
import { CAMERA_SHAKE_ASSET_TYPE, CURVE_ASSET_TYPES, GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE, normalizeCameraShakePayload, curveKindForAssetType, normalizeGlobalParameterCollection, isTimelineClipAssetType, normalizeCurveAssetPayload, timelineClipAssetCatalogEntry } from "@haptic/core";
import { isAnimGraphAssetType, normalizeWaterDefinition, type WaterDefinition } from "@haptic/core";
import { normalizeRenderTargetPayload, normalizeRenderTargetTexturePayload, type RenderTargetPayload, type RenderTargetTexturePayload } from "@haptic/core";
import {
  parseAnimGraphDocument,
  resolveAnimGraphClips,
  type AnimClipCatalogEntry,
  type AnimGraphDocument,
} from "@haptic/anim-graph";
import {
  materialParameterTextureAssetGuids,
  applyTexturePixelSizeToSprite,
  hydrateSpriteAnimations,
  hydrateSpritePixelSizes,
  parseSpritePayload,
  modelClipAnimationGuidsFromAnimations,
  normalizeAnimationPayload,
  retargetAnimationLoadsFromAnimations,
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  isParticleAssetType,
  particleLibraryFromAssets,
  buildParticleParameterCatalog,
  normalizeSoundAttenuationPayload,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  parseSpriteAnimationPayload,
  refreshStaleTilemaps,
  spriteAnimationDurationMs,
  type AnimationPayload,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type ParticleLibrary,
  type RetargetAnimationLoad,
  type SoundAttenuationPayload,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
  type ModelPayload,
  complexCollisionModelGuids,
  cookComplexCollisionMeshes,
} from "@haptic/assets";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@haptic/behaviour-tree";
import type { ControlMessage, ScriptBundleEntry } from "@haptic/bridge";
import type { CollisionTriangleMesh, ScenePostProcessEntry } from "@haptic/core";
import {
  buildMaterialParameterCatalog,
  materializeMaterialInstance,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
  resolveMaterialInstance,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialInstanceDocument,
  type MaterialSource,
} from "@haptic/shader-graph";
import type { GameSourceContent } from "./source-content";
import type { GameAssetIndexEntry } from "./types";

const decoder = new TextDecoder();
const JSON_CONTENT_TYPES = new Set([
  "RenderTarget", "RenderTargetTexture", "Sprite", "SpriteAnimation", "Water",
  "Tilemap", "Tileset", "AnimationGraph3D", "AnimationGraph2D", "BehaviourTree", "Blackboard",
  "Material", "MaterialInstance", "MaterialFunction", "AudioMixer", "AudioChannel",
  "SoundAttenuation", "Animation", "Audio",
  "DataDefinition", "DataTree", "Structure", "Enum", "FloatCurve", "VectorCurve", "ColorCurve",
  "GlobalParameterCollection", "TimelineClip2D", "TimelineClip3D", "CameraShake",
]);

export type PackedAudioLibrary = {
  sourceRevisions?: ReadonlyMap<string, string>;
  mixerGuid: string | null;
  mixers: Map<string, AudioMixerPayload>;
  channels: Map<string, AudioChannelPayload>;
  audio: Map<string, AudioPayload>;
  attenuations: Map<string, SoundAttenuationPayload>;
};

export type PackedGameContent = {
  dataAssets: DataAssetCatalogEntry[];
  curveAssets: CurveAssetCatalogEntry[];
  /** Camera Shake assets by guid; Play Camera Shake reads them. */
  cameraShakeAssets: CameraShakeCatalogEntry[];
  /** Every Global Parameter Collection's parameters by guid. */
  globalParameterCatalog: GlobalParameterCatalog;
  timelineClipAssets: TimelineClipAssetCatalogEntry[];
  spritePayloads: Map<string, SpritePayload>;
  spriteAnimationPayloads: Map<string, SpriteAnimationPayload>;
  waterPayloads: Map<string, WaterDefinition>;
  tilemapPayloads: Map<string, TilemapPayload>;
  tilesetPayloads: Map<string, TilesetPayload>;
  animGraphs: Array<{ guid: string; document: unknown }>;
  behaviourTrees: Array<{ guid: string; document: unknown }>;
  blackboards: Array<{ guid: string; document: unknown }>;
  animClipCatalog: AnimClipCatalogEntry[];
  navmeshBytes: Uint8Array | null;
  navmeshByScene: Map<string, Uint8Array>;
  audioReverbBytes: Uint8Array | null;
  audioReverbByScene: Map<string, Uint8Array>;
  materialDocuments: Map<string, MaterialDocument>;
  materialFunctions: Map<string, MaterialFunctionDocument>;
  renderTargets: Map<string, RenderTargetPayload>;
  renderTargetTextures: Map<string, RenderTargetTexturePayload>;
  postProcessStack: ScenePostProcessEntry[];
  pixelsPerUnit: number;
  sortingLayers: readonly string[];
  pixelPerfect: boolean;
  nearestTextures: boolean;
  audioLibrary: PackedAudioLibrary;
  particleLibrary: ParticleLibrary;
  modelClipAnimationGuids: Map<string, Map<string, string>>;
  retargetAnimationLoads: Map<string, RetargetAnimationLoad[]>;
  modelPayloads: Map<string, ModelPayload>;
  /** Cooked only for Models the content scan marks as Use Complex Collision. */
  complexMeshes: Map<string, CollisionTriangleMesh>;
  /** Authored Texture payload pixels for overlay 2DTexture world size. */
  texturePixelSizes: Map<string, { width: number; height: number }>;
};

function jsonFromBytes(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

function texturePixelSizesFromManifest(
  assets: GameSourceContent["manifest"]["assets"] | undefined,
): Map<string, { width: number; height: number }> {
  const sizes = new Map<string, { width: number; height: number }>();
  for (const entry of assets ?? []) {
    if (entry.type !== "Texture") continue;
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (!(width > 0) || !(height > 0)) continue;
    sizes.set(entry.guid, { width, height });
  }
  return sizes;
}

function asSpriteAnimationPayload(
  value: unknown,
): SpriteAnimationPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { frames?: unknown; clips?: unknown };
  if (!Array.isArray(record.frames) || Array.isArray(record.clips)) return null;
  return parseSpriteAnimationPayload(value);
}

/**
 * Each loaded payload's normalized value, keyed by the payload object: its bytes, or its decoded document.
 * Hosts never edit a published payload in place (`GameSourceContent`), so a source refresh or a render subset
 * that holds the same payload reuses its value, and its documents keep their identity, instead of parsing and
 * normalizing it again. Callers must not change a returned value.
 */
const normalizedPayloads = new WeakMap<object, { guid: string; type: string; name: string | undefined; value: unknown }>();

function normalizedEntry(entry: GameAssetIndexEntry, payload: object, parse: () => unknown): unknown {
  const cached = normalizedPayloads.get(payload);
  if (cached && cached.guid === entry.guid && cached.type === entry.type && cached.name === entry.name) return cached.value;
  const value = normalizeEntry(entry, parse());
  normalizedPayloads.set(payload, { guid: entry.guid, type: entry.type, name: entry.name, value });
  return value;
}

/** The value `packedContentFromGame` keeps for one JSON entry, or null when it keeps none. */
function normalizeEntry(entry: GameAssetIndexEntry, parsed: unknown): unknown {
  if (!parsed) return null;
  const { guid, type, name } = entry;
  if (type === "DataDefinition" || type === "DataTree" || type === "Structure" || type === "Enum") return parsed;
  if (type === GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE) return normalizeGlobalParameterCollection(parsed).parameters;
  const curveKind = curveKindForAssetType(type);
  if (curveKind) return normalizeCurveAssetPayload(curveKind, parsed);
  if (type === CAMERA_SHAKE_ASSET_TYPE) return normalizeCameraShakePayload(parsed);
  // Keys, events and proxies only: the Editor Preview never ships.
  if (isTimelineClipAssetType(type)) return timelineClipAssetCatalogEntry(guid, type, name ?? guid, parsed);
  switch (type) {
    case "RenderTarget": return normalizeRenderTargetPayload(parsed);
    case "RenderTargetTexture": return normalizeRenderTargetTexturePayload(parsed);
    case "Sprite": return typeof parsed === "object" ? parseSpritePayload(parsed) : null;
    case "SpriteAnimation": return asSpriteAnimationPayload(parsed);
    case "Water": return normalizeWaterDefinition(parsed);
    case "Tilemap": return normalizeTilemapPayload(parsed);
    case "Tileset": return normalizeTilesetPayload(parsed);
    case "AnimationGraph3D": return parseAnimGraphDocument(parsed, "3d");
    case "AnimationGraph2D": return parseAnimGraphDocument(parsed, "2d");
    case "BehaviourTree": return parseBehaviourTreeDocument(parsed);
    case "Blackboard": return parseBlackboardDocument(parsed);
    case "Material": return normalizeMaterialDocument(parsed, name ?? "Material");
    case "MaterialInstance": return normalizeMaterialInstanceDocument(parsed, name ?? "Material Instance");
    case "MaterialFunction": return normalizeMaterialFunctionDocument(parsed, name ?? "Material Function");
    case "AudioMixer": return normalizeAudioMixerPayload(parsed);
    case "AudioChannel": return normalizeAudioChannelPayload(parsed);
    case "SoundAttenuation": return normalizeSoundAttenuationPayload(parsed);
    case "Audio": return normalizeAudioPayload(parsed);
    case "Animation": return normalizeAnimationPayload(parsed);
  }
  return isParticleAssetType(type) ? parsed : null;
}

/** Each instance's materialized document, kept while its chain (the instance, its parents and the root) is the same documents. */
const materializedDocuments = new WeakMap<MaterialInstanceDocument, { rootGuid: string; chain: readonly object[]; document: MaterialDocument }>();

/** `materializeMaterialInstances` for documents that are never edited in place (`normalizedPayloads`). */
function materializedInstances(
  materials: ReadonlyMap<string, MaterialDocument>,
  instances: ReadonlyMap<string, MaterialInstanceDocument>,
): Map<string, MaterialDocument> {
  const lookup = (guid: string): MaterialSource | null => {
    const material = materials.get(guid);
    if (material) return { kind: "material", document: material };
    const instance = instances.get(guid);
    return instance ? { kind: "instance", document: instance } : null;
  };
  const result = new Map<string, MaterialDocument>();
  for (const [guid, instance] of instances) {
    const resolved = resolveMaterialInstance(guid, lookup);
    if (!resolved.ok) continue;
    const chain = resolved.chain.map((id) => lookup(id)!.document);
    const cached = materializedDocuments.get(instance);
    if (cached && cached.rootGuid === resolved.rootGuid && cached.chain.length === chain.length && cached.chain.every((document, index) => document === chain[index])) {
      result.set(guid, cached.document);
      continue;
    }
    const document = materializeMaterialInstance(resolved.root, resolved.rootGuid, resolved.overrides, instance);
    materializedDocuments.set(instance, { rootGuid: resolved.rootGuid, chain, document });
    result.set(guid, document);
  }
  return result;
}

/** Models this source set's Scenes, SceneLayers and Classes simulate with Use Complex Collision. */
function gameComplexCollisionModelGuids(game: GameSourceContent): Set<string> {
  return complexCollisionModelGuids([
    ...game.scenes.values(), ...game.sceneLayers.values(), ...game.scripts, ...(game.decodedPayloads?.values() ?? []),
  ]);
}

export function packedContentFromGame(game: GameSourceContent): PackedGameContent {
  const dataAssets: DataAssetCatalogEntry[] = [];
  const curveAssets: CurveAssetCatalogEntry[] = [];
  const cameraShakeAssets: CameraShakeCatalogEntry[] = [];
  const globalParameterCatalog: GlobalParameterCatalog = {};
  const timelineClipAssets: TimelineClipAssetCatalogEntry[] = [];
  const spritePayloads = new Map<string, SpritePayload>();
  const spriteAnimationPayloads = new Map<string, SpriteAnimationPayload>();
  const waterPayloads = new Map<string, WaterDefinition>();
  const tilemapPayloads = new Map<string, TilemapPayload>();
  const tilesetPayloads = new Map<string, TilesetPayload>();
  const animGraphs: Array<{ guid: string; document: AnimGraphDocument }> = [];
  const behaviourTrees: Array<{ guid: string; document: unknown }> = [];
  const blackboards: Array<{ guid: string; document: unknown }> = [];
  const materialDocuments = new Map<string, MaterialDocument>();
  const materialFunctions = new Map<string, MaterialFunctionDocument>();
  const materialInstances = new Map<string, MaterialInstanceDocument>();
  const renderTargets = new Map<string, RenderTargetPayload>();
  const renderTargetTextures = new Map<string, RenderTargetTexturePayload>();
  const mixers = new Map<string, AudioMixerPayload>();
  const channels = new Map<string, AudioChannelPayload>();
  const audio = new Map<string, AudioPayload>(game.audioPayloads);
  const attenuations = new Map<string, SoundAttenuationPayload>();
  const particleAssets: Array<{ guid: string; type: string; name?: string; payload: unknown }> = [];
  const animationPayloads = new Map<string, AnimationPayload>();
  const animationNames = new Map<string, string>();

  for (const entry of game.manifest.assets ?? []) {
    if (!JSON_CONTENT_TYPES.has(entry.type) && !isParticleAssetType(entry.type)) continue;
    // Packed Audio already has its envelope parsed; its clip data is binary.
    if (entry.type === "Audio" && audio.has(entry.guid)) continue;
    const bytes = game.payloads.get(entry.guid);
    const decoded = game.decodedPayloads?.get(entry.guid);
    if (!bytes && decoded === undefined) continue;
    const value = normalizedEntry(entry, decoded ?? bytes!, () => decoded ?? jsonFromBytes(bytes!));
    if (value === null || value === undefined) continue;
    const name = entry.name ?? entry.guid;
    const curveKind = curveKindForAssetType(entry.type);
    if (entry.type === "DataDefinition" || entry.type === "DataTree" || entry.type === "Structure" || entry.type === "Enum") {
      dataAssets.push({ guid: entry.guid, type: entry.type, name, payload: value });
    } else if (entry.type === GLOBAL_PARAMETER_COLLECTION_ASSET_TYPE) globalParameterCatalog[entry.guid] = value as GlobalParameterCatalog[string];
    else if (entry.type === CAMERA_SHAKE_ASSET_TYPE) cameraShakeAssets.push({ guid: entry.guid, name, payload: value as CameraShakeCatalogEntry["payload"] });
    else if (curveKind) curveAssets.push({ guid: entry.guid, type: CURVE_ASSET_TYPES[curveKind], name, payload: value as CurveAssetCatalogEntry["payload"] });
    else if (isTimelineClipAssetType(entry.type)) timelineClipAssets.push(value as TimelineClipAssetCatalogEntry);
    else if (entry.type === "RenderTarget") renderTargets.set(entry.guid, value as RenderTargetPayload);
    else if (entry.type === "RenderTargetTexture") renderTargetTextures.set(entry.guid, value as RenderTargetTexturePayload);
    else if (entry.type === "Sprite") spritePayloads.set(entry.guid, value as SpritePayload);
    else if (entry.type === "SpriteAnimation") spriteAnimationPayloads.set(entry.guid, value as SpriteAnimationPayload);
    else if (entry.type === "Water") waterPayloads.set(entry.guid, value as WaterDefinition);
    else if (entry.type === "Tilemap") tilemapPayloads.set(entry.guid, value as TilemapPayload);
    else if (entry.type === "Tileset") tilesetPayloads.set(entry.guid, value as TilesetPayload);
    else if (isAnimGraphAssetType(entry.type)) animGraphs.push({ guid: entry.guid, document: value as AnimGraphDocument });
    else if (entry.type === "BehaviourTree") behaviourTrees.push({ guid: entry.guid, document: value });
    else if (entry.type === "Blackboard") blackboards.push({ guid: entry.guid, document: value });
    else if (entry.type === "Material") materialDocuments.set(entry.guid, value as MaterialDocument);
    else if (entry.type === "MaterialInstance") materialInstances.set(entry.guid, value as MaterialInstanceDocument);
    else if (entry.type === "MaterialFunction") materialFunctions.set(entry.guid, value as MaterialFunctionDocument);
    else if (entry.type === "AudioMixer") mixers.set(entry.guid, value as AudioMixerPayload);
    else if (entry.type === "AudioChannel") channels.set(entry.guid, value as AudioChannelPayload);
    else if (entry.type === "SoundAttenuation") attenuations.set(entry.guid, value as SoundAttenuationPayload);
    else if (entry.type === "Audio") audio.set(entry.guid, value as AudioPayload);
    else if (isParticleAssetType(entry.type)) particleAssets.push({ guid: entry.guid, type: entry.type, name: entry.name, payload: value });
    else if (entry.type === "Animation") {
      animationPayloads.set(entry.guid, value as AnimationPayload);
      if (entry.name?.trim()) animationNames.set(entry.guid, entry.name.trim());
    }
  }

  const startup = game.manifest.startupSceneGuid;
  const navmeshByScene = new Map(game.navmeshBytes);
  const navmeshBytes = navmeshByScene.get(startup) ?? null;
  const audioReverbByScene = new Map(game.audioReverbBytes);
  const audioReverbBytes = audioReverbByScene.get(startup) ?? null;
  const startupScene = game.scenes.get(startup);
  const pixelsPerUnit =
    typeof game.manifest.pixelsPerUnit === "number" && game.manifest.pixelsPerUnit > 0
      ? game.manifest.pixelsPerUnit
      : 100;

  // Authored Texture sizes from the catalog first; packed PNG headers fill the rest
  // (a KTX2 chunk has no PNG header).
  const texturePixelSizes = texturePixelSizesFromManifest(game.manifest.assets);
  const sizedSprites = hydrateSpritePixelSizes(
    new Map([...spritePayloads].map(([guid, payload]) => [guid,
      applyTexturePixelSizeToSprite(payload, (textureGuid) => texturePixelSizes.get(textureGuid))])),
    game.textureBytes,
  );
  // Sprite frames take their Sprite's Texture, size, pivot and collision; sheet cells their UVs.
  const sizedSpriteAnimations = hydrateSpriteAnimations(spriteAnimationPayloads, {
    sprites: sizedSprites,
    textureSizes: texturePixelSizes,
    textureBytes: game.textureBytes,
  });

  const animations = [...animationPayloads].map(([guid, payload]) => ({ guid, payload }));
  // A Model plays the Animations retargeted onto it and every other Model's Animation on its Skeleton.
  const retargetAnimationLoads = retargetAnimationLoadsFromAnimations(
    animations,
    new Map([...game.modelPayloads].map(([guid, payload]) => [guid, payload.skeletonGuid])),
  );
  const clipCatalog: AnimClipCatalogEntry[] = [
    ...[...animationPayloads.entries()].map(([guid, payload]) => ({
      guid,
      type: "Animation",
      name: animationNames.get(guid) ?? payload.clipName,
      clipName: payload.clipName,
      ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
      ...(payload.skeletonGuid ? { skeletonGuid: payload.skeletonGuid } : {}),
      ...(payload.modelGuid ? { modelGuid: payload.modelGuid } : {}),
    })),
    ...[...sizedSpriteAnimations.entries()].map(([guid, payload]) => ({
      guid,
      type: "SpriteAnimation",
      name: guid,
      durationMs: spriteAnimationDurationMs(payload),
      frameCount: payload.frames.length,
    })),
  ];
  const resolvedAnimGraphs = animGraphs.map((entry) => ({
    guid: entry.guid,
    document: resolveAnimGraphClips(entry.document, clipCatalog),
  }));

  for (const [guid, document] of materializedInstances(materialDocuments, materialInstances)) {
    materialDocuments.set(guid, document);
  }

  return {
    dataAssets,
    curveAssets,
    cameraShakeAssets,
    globalParameterCatalog,
    timelineClipAssets,
    spritePayloads: sizedSprites,
    spriteAnimationPayloads: sizedSpriteAnimations,
    waterPayloads,
    // Play, Simulate, Preview Build and exported games draw, collide and send the maps as the current Tilesets resolve them.
    tilemapPayloads: refreshStaleTilemaps(tilemapPayloads, tilesetPayloads),
    tilesetPayloads,
    animGraphs: resolvedAnimGraphs,
    behaviourTrees,
    blackboards,
    animClipCatalog: clipCatalog,
    navmeshBytes,
    navmeshByScene,
    audioReverbBytes,
    audioReverbByScene,
    materialDocuments,
    materialFunctions,
    renderTargets,
    renderTargetTextures,
    postProcessStack: startupScene?.settings.postProcessStack ?? [],
    pixelsPerUnit,
    sortingLayers: game.manifest.sortingLayers,
    pixelPerfect: game.manifest.pixelPerfect === true,
    nearestTextures: game.manifest.nearestTextures === true,
    audioLibrary: {
      sourceRevisions: new Map((game.manifest.assets ?? []).filter(entry => entry.type === "Audio" && audio.has(entry.guid) && entry.revision).map(entry => [entry.guid, entry.revision!])),
      mixerGuid: game.manifest.audioMixerGuid?.trim() || null,
      mixers,
      channels,
      audio,
      attenuations,
    },
    particleLibrary: particleLibraryFromAssets(particleAssets),
    modelClipAnimationGuids: modelClipAnimationGuidsFromAnimations(animations),
    retargetAnimationLoads,
    modelPayloads: new Map(game.modelPayloads),
    complexMeshes: game.complexMeshes ? new Map(game.complexMeshes)
      : cookComplexCollisionMeshes(game.modelBytes, game.modelPayloads, gameComplexCollisionModelGuids(game)),
    texturePixelSizes,
  };
}

export function packedPlayControls(content: PackedGameContent): ControlMessage[] {
  const controls: ControlMessage[] = [];
  if (content.animGraphs.length > 0) {
    controls.push({ type: "loadAnimGraphs", graphs: [...content.animGraphs] });
  }
  if (content.spritePayloads.size > 0 || content.spriteAnimationPayloads.size > 0) {
    controls.push({
      type: "loadSprites",
      sprites: [...content.spritePayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      spriteAnimations: [...content.spriteAnimationPayloads.entries()].map(
        ([guid, document]) => ({ guid, document }),
      ),
      ...(content.pixelsPerUnit > 0 ? { pixelsPerUnit: content.pixelsPerUnit } : {}),
    });
  }
  if (content.behaviourTrees.length > 0 || content.blackboards.length > 0) {
    controls.push({
      type: "loadBehaviourTrees",
      trees: [...content.behaviourTrees],
      blackboards: [...content.blackboards],
    });
  }
  if (content.waterPayloads.size > 0) controls.push({ type: "loadWater", waters: [...content.waterPayloads].map(([guid, document]) => ({ guid, document })) });
  if (content.tilemapPayloads.size > 0 || content.tilesetPayloads.size > 0) {
    controls.push({
      type: "loadTilemaps",
      tilemaps: [...content.tilemapPayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      tilesets: [...content.tilesetPayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      ...(content.pixelsPerUnit > 0 ? { pixelsPerUnit: content.pixelsPerUnit } : {}),
    });
  }
  if (content.modelPayloads.size > 0) {
    controls.push({
      type: "loadModels",
      models: [...content.modelPayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      ...(content.complexMeshes.size > 0
        ? {
            complexMeshes: [...content.complexMeshes.entries()].map(
              ([guid, mesh]) => ({
                guid,
                positions: mesh.positions,
                indices: mesh.indices,
              }),
            ),
          }
        : {}),
    });
  }
  // The startup Scene's mesh is in `navmeshByScene`, which the host's `load` sends as
  // `sceneNavmeshBytes`: the worker imports that entry instead of a second copy.
  if (content.navmeshBytes && content.navmeshBytes.byteLength > 0) controls.push({ type: "loadNavMesh" });
  return controls;
}

export function packedBootControls(
  content: PackedGameContent,
  scripts: readonly ScriptBundleEntry[],
): ControlMessage[] {
  const controls: ControlMessage[] = [];
  if (scripts.length > 0) {
    controls.push({
      type: "loadScripts",
      scripts: [...scripts],
      spawn: [],
    });
  }
  controls.push(...packedPlayControls(content));
  controls.push({ type: "play" });
  return controls;
}

/** Replace the runtime's source union after acquisition or release, including empty collections. */
export function packedSourceControls(game: GameSourceContent, content = packedContentFromGame(game)): ControlMessage[] {
  const controls: ControlMessage[] = [{ type: "loadScripts", scripts: [...game.scripts], spawn: [], replace: true }, {
    type: "loadSceneContent", assetGuids: [...game.payloads.keys(), ...(game.decodedPayloads?.keys() ?? [])],
    sceneLayers: [...game.sceneLayers].map(([guid, layer]) => ({ guid, layer })),
    sceneNavmeshBytes: Object.fromEntries(game.navmeshBytes),
    dataAssets: content.dataAssets, curveAssets: content.curveAssets, cameraShakeAssets: content.cameraShakeAssets, globalParameterCatalog: content.globalParameterCatalog, timelineClipAssets: content.timelineClipAssets, audioAssetGuids: game.manifest.assets.filter(entry => entry.type === "Audio").map(entry => entry.guid),
    materialParameterCatalog: buildMaterialParameterCatalog(content.materialDocuments, content.materialFunctions),
    particleParameterCatalog: buildParticleParameterCatalog(content.particleLibrary),
    materialTextureAssetGuids: materialParameterTextureAssetGuids(game.textureBytes, content.renderTargetTextures),
    renderTargets: Object.fromEntries(content.renderTargets), renderTargetTextures: Object.fromEntries(content.renderTargetTextures),
    animClipCatalog: content.animClipCatalog,
  }, ...packedPlayControls(content).filter(control => control.type !== "loadNavMesh")];
  if (!controls.some(control => control.type === "loadWater")) controls.push({ type: "loadWater", waters: [] });
  if (!controls.some(control => control.type === "loadModels")) controls.push({ type: "loadModels", models: [], complexMeshes: [] });
  if (!controls.some(control => control.type === "loadSprites")) controls.push({ type: "loadSprites", sprites: [], spriteAnimations: [] });
  if (!controls.some(control => control.type === "loadTilemaps")) controls.push({ type: "loadTilemaps", tilemaps: [], tilesets: [] });
  return controls;
}
