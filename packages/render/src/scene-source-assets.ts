import type { ModelPayload, RetargetAnimationLoad } from "@haptic/assets";
import type { MaterialDocument, MaterialFunctionDocument } from "@haptic/shader-graph";
import type { AudioLibrary } from "./audio-service";
import type { ParticleLibrary } from "./particle-service";
import type { FontAssetEntry } from "./font-registry";
import type { MeshAssetContext } from "./mesh-assets";
import type { SpawnableLight } from "./spawnable-lights";

/** One consumer's prepared source data. Babylon resources stay in the existing caches. */
export interface SceneSourceAssets {
  assets?: MeshAssetContext;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  audioLibrary?: AudioLibrary;
  particleLibrary?: ParticleLibrary;
  fonts?: readonly FontAssetEntry[];
  /** The light parts its Classes may spawn, generic kinds included (`spawnableLightsOfLoad`). */
  spawnableLights?: ReadonlyMap<string, SpawnableLight>;
}

const assetMaps = ["renderTargets", "renderTargetTextures", "waters", "textureBytes", "areaEmissions",
  "texturePixelSizes", "spritePayloads", "spriteAnimations", "tilemaps", "tilesets", "modelBytes", "modelSources",
  "modelPayloads", "modelClipAnimationGuids", "retargetAnimationLoads", "fontFacetypeBytes",
  "fontMsdfJson", "fontMsdfPng", "fontCssStackByGuid", "fontPixelSizeByGuid"] as const satisfies readonly (keyof MeshAssetContext)[];

export function captureMeshSourceAssets(source: MeshAssetContext): MeshAssetContext {
  const assets: MeshAssetContext = {
    resourceCache: source.resourceCache, pixelsPerUnit: source.pixelsPerUnit, sortingLayers: source.sortingLayers,
    fontCssStack: source.fontCssStack,
    fontPixelSize: source.fontPixelSize,
  };
  const target = assets as Record<string, unknown>;
  for (const key of assetMaps) {
    const map = source[key] as ReadonlyMap<string, unknown> | undefined;
    target[key] = map ? new Map(map) : undefined;
  }
  return assets;
}

function mergeMaps<T>(maps: Iterable<ReadonlyMap<string, T> | undefined>): Map<string, T> {
  const result = new Map<string, T>();
  for (const map of maps) for (const [key, value] of map ?? []) result.set(key, value);
  return result;
}

/**
 * The clips each Model plays across sources. A source names only the Animations it loaded, so a Model's own clips
 * and its retargeted loads join those of every source, and each Model also plays every other held Model's own clip
 * on its Skeleton, bound by name (as `retargetAnimationLoadsFromAnimations` gives within one source): an Animation
 * loaded on demand later, with its own source, reaches the Models the first sources installed.
 */
function mergeModelAnimations(rows: readonly SceneSourceAssets[], payloads: ReadonlyMap<string, ModelPayload>): {
  clips: Map<string, Map<string, string>>;
  loads: Map<string, RetargetAnimationLoad[]>;
} {
  const clips = new Map<string, Map<string, string>>();
  for (const row of rows) {
    for (const [model, named] of row.assets?.modelClipAnimationGuids ?? []) {
      let merged = clips.get(model);
      if (!merged) clips.set(model, merged = new Map());
      for (const [clipName, animationGuid] of named) merged.set(clipName, animationGuid);
    }
  }
  const loads = new Map<string, RetargetAnimationLoad[]>();
  const add = (model: string, load: RetargetAnimationLoad) => {
    let list = loads.get(model);
    if (!list) loads.set(model, list = []);
    if (!list.some((entry) => entry.animationGuid === load.animationGuid)) list.push(load);
  };
  for (const row of rows) {
    for (const [model, list] of row.assets?.retargetAnimationLoads ?? []) for (const load of list) add(model, load);
  }
  const bySkeleton = new Map<string, string[]>();
  for (const [model, payload] of payloads) {
    if (!payload.skeletonGuid) continue;
    const models = bySkeleton.get(payload.skeletonGuid);
    if (models) models.push(model);
    else bySkeleton.set(payload.skeletonGuid, [model]);
  }
  for (const models of bySkeleton.values()) {
    for (const model of models) {
      for (const owner of models) {
        if (owner === model) continue;
        for (const [clipName, animationGuid] of clips.get(owner) ?? []) {
          add(model, { animationGuid, clipName, sourceModelGuid: owner, bindByName: true });
        }
      }
    }
  }
  return { clips, loads };
}

/** Empty maps are intentional: replacing a union must remove released source references. */
export function mergeSceneSourceAssets(sources: Iterable<SceneSourceAssets>): SceneSourceAssets {
  const rows = [...sources];
  const assets: MeshAssetContext = Object.assign({}, ...rows.map((row) => row.assets));
  const target = assets as Record<string, unknown>;
  for (const key of assetMaps) {
    target[key] = mergeMaps(rows.map((row) => row.assets?.[key] as ReadonlyMap<string, unknown> | undefined));
  }
  const animations = mergeModelAnimations(rows, assets.modelPayloads ?? new Map());
  assets.modelClipAnimationGuids = animations.clips;
  assets.retargetAnimationLoads = animations.loads;
  const audio = rows.flatMap((row) => row.audioLibrary ? [row.audioLibrary] : []);
  const particles = rows.flatMap((row) => row.particleLibrary ? [row.particleLibrary] : []);
  return {
    assets,
    materialDocuments: mergeMaps(rows.map((row) => row.materialDocuments)),
    materialFunctions: mergeMaps(rows.map((row) => row.materialFunctions)),
    audioLibrary: {
      mixerGuid: [...audio].reverse().find((entry) => entry.mixerGuid !== null)?.mixerGuid ?? null,
      mixers: mergeMaps(audio.map((entry) => entry.mixers)), channels: mergeMaps(audio.map((entry) => entry.channels)),
      audio: mergeMaps(audio.map((entry) => entry.audio)), attenuations: mergeMaps(audio.map((entry) => entry.attenuations)),
      sourceRevisions: mergeMaps(audio.map((entry) => entry.sourceRevisions)),
    },
    particleLibrary: {
      systems: mergeMaps(particles.map((entry) => entry.systems)),
      emitters: mergeMaps(particles.map((entry) => entry.emitters)),
    },
    fonts: [...new Map(rows.flatMap((row) => (row.fonts ?? []).map((font) => [font.guid, font] as const))).values()],
    spawnableLights: mergeMaps(rows.map((row) => row.spawnableLights)),
  };
}
