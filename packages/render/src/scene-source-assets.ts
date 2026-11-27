import type { ModelPayload, RetargetAnimationLoad } from "@haptic/assets";
import type { MaterialDocument, MaterialFunctionDocument } from "@haptic/shader-graph";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
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

function sameByteView(a: BufferSource, b: BufferSource): boolean {
  if (a === b) return true;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.byteLength === b.byteLength) return true;
    const viewA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const viewB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return assetByteFingerprint(viewA) === assetByteFingerprint(viewB);
  }
  return false;
}

function sameSourceValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if ((a instanceof Blob || a instanceof Uint8Array) && (b instanceof Blob || b instanceof Uint8Array)) {
    return assetByteFingerprint(a) === assetByteFingerprint(b);
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b) || a instanceof Blob || b instanceof Blob) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameSourceValue(a[i], arrB[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameSourceValue(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameSourceValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function mapIsSubset<T>(
  incoming: ReadonlyMap<string, T> | undefined,
  installed: ReadonlyMap<string, T> | undefined,
  equal: (a: T, b: T) => boolean = sameSourceValue,
): boolean {
  if (!incoming || incoming.size === 0) return true;
  if (!installed) return false;
  for (const [key, value] of incoming) {
    if (!installed.has(key) || !equal(value, installed.get(key)!)) return false;
  }
  return true;
}

/**
 * True when merging `incoming` on top of `installed` would leave the merged `SceneSourceAssets`
 * union unchanged. Runs in O(|incoming|) so Play startup actor acquisitions (already covered by
 * the startup Scene's owner 0) avoid O(N^2) full-union rebuilds while keeping per-owner leases.
 */
export function isSceneSourceAssetsSubset(incoming: SceneSourceAssets, installed: SceneSourceAssets): boolean {
  const incAssets = incoming.assets;
  const instAssets = installed.assets;
  if (incAssets) {
    if (!instAssets) return false;
    if (incAssets.resourceCache !== undefined && incAssets.resourceCache !== instAssets.resourceCache) return false;
    if (typeof incAssets.pixelsPerUnit === "number" && incAssets.pixelsPerUnit !== instAssets.pixelsPerUnit) return false;
    if (incAssets.sortingLayers !== undefined && !sameSourceValue(incAssets.sortingLayers, instAssets.sortingLayers)) return false;
    if (incAssets.fontCssStack !== undefined && incAssets.fontCssStack !== instAssets.fontCssStack) return false;
    if (incAssets.fontPixelSize !== undefined && incAssets.fontPixelSize !== instAssets.fontPixelSize) return false;
    for (const key of assetMaps) {
      if (key === "modelClipAnimationGuids") {
        const incClips = incAssets.modelClipAnimationGuids;
        const instClips = instAssets.modelClipAnimationGuids;
        if (incClips && incClips.size > 0) {
          if (!instClips) return false;
          for (const [model, named] of incClips) {
            if (!mapIsSubset(named, instClips.get(model), Object.is)) return false;
          }
        }
      } else if (key === "retargetAnimationLoads") {
        const incLoads = incAssets.retargetAnimationLoads;
        const instLoads = instAssets.retargetAnimationLoads;
        if (incLoads && incLoads.size > 0) {
          if (!instLoads) return false;
          for (const [model, list] of incLoads) {
            const existing = instLoads.get(model);
            if (!existing) return false;
            for (const load of list) {
              if (!existing.some((entry) => entry.animationGuid === load.animationGuid)) return false;
            }
          }
        }
      } else {
        const incMap = incAssets[key] as ReadonlyMap<string, unknown> | undefined;
        const instMap = instAssets[key] as ReadonlyMap<string, unknown> | undefined;
        if (!mapIsSubset(incMap, instMap)) return false;
      }
    }
  }
  if (!mapIsSubset(incoming.materialDocuments, installed.materialDocuments)) return false;
  if (!mapIsSubset(incoming.materialFunctions, installed.materialFunctions)) return false;
  if (!mapIsSubset(incoming.spawnableLights, installed.spawnableLights)) return false;
  if (incoming.audioLibrary) {
    const instAudio = installed.audioLibrary;
    if (!instAudio) return false;
    if (incoming.audioLibrary.mixerGuid !== null && incoming.audioLibrary.mixerGuid !== instAudio.mixerGuid) return false;
    if (!mapIsSubset(incoming.audioLibrary.mixers, instAudio.mixers)) return false;
    if (!mapIsSubset(incoming.audioLibrary.channels, instAudio.channels)) return false;
    if (!mapIsSubset(incoming.audioLibrary.audio, instAudio.audio)) return false;
    if (!mapIsSubset(incoming.audioLibrary.attenuations, instAudio.attenuations)) return false;
    if (!mapIsSubset(incoming.audioLibrary.sourceRevisions, instAudio.sourceRevisions, Object.is)) return false;
  }
  if (incoming.particleLibrary) {
    const instParticles = installed.particleLibrary;
    if (!instParticles) return false;
    if (!mapIsSubset(incoming.particleLibrary.systems, instParticles.systems)) return false;
    if (!mapIsSubset(incoming.particleLibrary.emitters, instParticles.emitters)) return false;
  }
  if (incoming.fonts && incoming.fonts.length > 0) {
    const instFonts = installed.fonts;
    if (!instFonts || instFonts.length === 0) return false;
    for (const font of incoming.fonts) {
      const existing = instFonts.find((entry) => entry.guid === font.guid);
      if (
        !existing ||
        existing.family !== font.family ||
        existing.weight !== font.weight ||
        existing.style !== font.style ||
        !sameByteView(existing.bytes, font.bytes)
      ) {
        return false;
      }
    }
  }
  return true;
}
