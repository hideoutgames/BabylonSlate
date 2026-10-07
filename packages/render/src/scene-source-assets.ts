import type { MaterialDocument, MaterialFunctionDocument } from "@babylonslate/shader-graph";
import type { AudioLibrary } from "./audio-service";
import type { ParticleLibrary } from "./particle-service";
import type { FontAssetEntry } from "./font-registry";
import type { MeshAssetContext } from "./mesh-assets";

/** One consumer's prepared source data. Babylon resources stay in the existing caches. */
export interface SceneSourceAssets {
  assets?: MeshAssetContext;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  audioLibrary?: AudioLibrary;
  particleLibrary?: ParticleLibrary;
  fonts?: readonly FontAssetEntry[];
}

const assetMaps = ["renderTargets", "renderTargetTextures", "waters", "textureBytes", "areaEmissions",
  "texturePixelSizes", "spritePayloads", "spriteAnimations", "tilemaps", "tilesets", "modelBytes", "modelSources",
  "modelPayloads", "materialTextureGuids", "modelClipAnimationGuids", "retargetAnimationLoads", "fontFacetypeBytes",
  "fontMsdfJson", "fontMsdfPng", "fontCssStackByGuid"] as const satisfies readonly (keyof MeshAssetContext)[];

export function captureMeshSourceAssets(source: MeshAssetContext): MeshAssetContext {
  const assets: MeshAssetContext = {
    resourceCache: source.resourceCache, pixelsPerUnit: source.pixelsPerUnit, sortingLayers: source.sortingLayers,
    fontCssStack: source.fontCssStack,
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

/** Empty maps are intentional: replacing a union must remove released source references. */
export function mergeSceneSourceAssets(sources: Iterable<SceneSourceAssets>): SceneSourceAssets {
  const rows = [...sources];
  const assets: MeshAssetContext = Object.assign({}, ...rows.map((row) => row.assets));
  const target = assets as Record<string, unknown>;
  for (const key of assetMaps) {
    target[key] = mergeMaps(rows.map((row) => row.assets?.[key] as ReadonlyMap<string, unknown> | undefined));
  }
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
  };
}
