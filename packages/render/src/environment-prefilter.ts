import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { retainEngineEffect } from "./effect-bridge";
import { withDrawingState } from "./engine-drawing-state";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
} from "./managed-render-resources";

/** Face size of a filtered environment: rough lighting needs no more, and it bounds the filter's GPU work. */
const FILTERED_ENVIRONMENT_SIZE = 256;
/**
 * Importance samples per texel; each reads the source mip matching its lobe, so
 * few are needed. Babylon's real-time filtering calls 64 high quality.
 */
const FILTER_SAMPLES = 64;
// Babylon's PBR maps roughness to a mip through these; the filter writes the matching lobe per mip.
const LOD_GENERATION_SCALE = 0.8;
const LOD_GENERATION_OFFSET = 0;

export interface FilteredEnvironment {
  /** GGX-prefiltered linear cube, usable once `ready` resolves. */
  readonly cube: CubeTexture;
  readonly ready: Promise<void>;
  release(): void;
}

/**
 * How long an unreferenced GGX-prefiltered environment cube stays parked on its Engine for the next Scene
 * (Play start/stop, Scene tab reopen), matching `PARKED_SHADOW_ATLAS_MS`.
 */
export const PARKED_FILTERED_ENVIRONMENT_MS = 10_000;

type Entry = {
  owned: FilteredEnvironmentTarget;
  ready: Promise<void>;
  references: number;
  parkedTimer: ReturnType<typeof setTimeout> | null;
  failed: boolean;
};
type EngineCache = {
  entries: Map<InternalTexture, Entry>;
  lost: Observer<AbstractEngine>;
  disposed: Observer<AbstractEngine>;
};
const caches = new WeakMap<AbstractEngine, EngineCache>();

function dropEntry(cache: Map<InternalTexture, Entry>, internal: InternalTexture, entry: Entry): void {
  if (entry.parkedTimer !== null) {
    clearTimeout(entry.parkedTimer);
    entry.parkedTimer = null;
  }
  if (cache.get(internal) === entry) cache.delete(internal);
  entry.owned.release();
}

/** Releases every parked (zero-reference) filtered environment cube on `engine` immediately. */
export function discardParkedFilteredEnvironments(engine: AbstractEngine): number {
  const bucket = caches.get(engine);
  if (!bucket) return 0;
  let discarded = 0;
  for (const [internal, entry] of [...bucket.entries]) {
    if (entry.references !== 0) continue;
    dropEntry(bucket.entries, internal, entry);
    discarded += 1;
  }
  return discarded;
}

/** Internal textures of parked filtered environment cubes on `engine`, which no live Scene holds. */
export function parkedFilteredEnvironmentTextures(engine: AbstractEngine): InternalTexture[] {
  const bucket = caches.get(engine);
  if (!bucket) return [];
  const textures: InternalTexture[] = [];
  for (const entry of bucket.entries.values()) {
    if (entry.references !== 0) continue;
    const internal = entry.owned.cube.getInternalTexture();
    if (internal) textures.push(internal);
  }
  return textures;
}

// Babylon's cube face basis for the hdrFiltering vertex shader (up, right, front per face).
const FACES = [
  [[0, 0, -1], [0, -1, 0], [1, 0, 0]],
  [[0, 0, 1], [0, -1, 0], [-1, 0, 0]],
  [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[1, 0, 0], [0, -1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, -1, 0], [0, 0, -1]],
] as const;

function filteredSize(sourceWidth: number): number {
  let size = 1;
  while (size * 2 <= Math.min(sourceWidth, FILTERED_ENVIRONMENT_SIZE)) size *= 2;
  return size;
}

function cubeBytes(size: number, bytesPerTexel: number): number {
  let bytes = 0;
  for (let face = size; face >= 1; face >>= 1) bytes += face * face * 6 * bytesPerTexel;
  return bytes;
}

/** A filtered environment cube's GPU target, its engine-bound wrapper and its budget reservation. */
export interface FilteredEnvironmentTarget {
  readonly cube: CubeTexture;
  readonly target: RenderTargetWrapper;
  readonly size: number;
  release(): void;
}

/**
 * Allocate a filtered environment cube of at most `faceSize` per face. Null
 * when the device cannot filter or the managed rendering budget is spent.
 */
export function createFilteredEnvironmentTarget(engine: AbstractEngine, faceSize: number): FilteredEnvironmentTarget | null {
  const caps = engine.getCaps();
  if (!engine._features.allowTexturePrefiltering || !caps.textureLOD) return null;
  const type = caps.textureHalfFloatRender
    ? Constants.TEXTURETYPE_HALF_FLOAT
    : caps.textureFloatRender ? Constants.TEXTURETYPE_FLOAT : null;
  if (type === null) return null;
  const size = filteredSize(faceSize);
  const bytes = cubeBytes(size, type === Constants.TEXTURETYPE_FLOAT ? 16 : 8);
  const lease = beginManagedRenderAllocation(engine, bytes);
  if (!lease) return null;
  let target: RenderTargetWrapper | undefined;
  let cube: CubeTexture | undefined;
  try {
    target = engine.createRenderTargetCubeTexture(size, {
      format: Constants.TEXTUREFORMAT_RGBA,
      type,
      // Pinned 9.29: WebGL cube targets ignore createMipMaps and allocate mips only by generating them.
      createMipMaps: true,
      generateMipMaps: true,
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      label: "Filtered environment",
    });
    // Every mip is written by the filter; nothing may regenerate them over it.
    target.texture!.generateMipMaps = false;
    engine.updateTextureWrappingMode(target.texture!, Constants.TEXTURE_CLAMP_ADDRESSMODE, Constants.TEXTURE_CLAMP_ADDRESSMODE, Constants.TEXTURE_CLAMP_ADDRESSMODE);
    // An engine-bound wrapper sharing the target's texture: Scene disposal never drops it.
    cube = new CubeTexture("", engine);
    target.texture!.incrementReferences();
    cube._texture = target.texture;
    cube.gammaSpace = false;
    cube.lodGenerationScale = LOD_GENERATION_SCALE;
    cube.lodGenerationOffset = LOD_GENERATION_OFFSET;
    cube._prefiltered = true;
    lease.commit([{ handle: target.texture!, bytes, category: "environment" }]);
  } catch (error) {
    cube?.dispose();
    target?.dispose();
    void releaseManagedRenderLeaseAfterDisposal(engine, lease);
    throw error;
  }
  const owned = { cube, target };
  let released = false;
  return {
    cube, target, size,
    release: () => {
      if (released) return;
      released = true;
      owned.cube.dispose();
      owned.target.dispose();
      void releaseManagedRenderLeaseAfterDisposal(engine, lease);
    },
  };
}

/**
 * Filter a ready source cube (a Skybox's) for image-based lighting: each mip
 * holds the GGX lobe Babylon's PBR samples it for, at a bounded face size.
 * Shared per Engine and source upload. Null when the device cannot filter or
 * the managed rendering budget is spent; callers then light from the source.
 */
export function retainFilteredEnvironment(
  engine: AbstractEngine,
  source: CubeTexture,
): FilteredEnvironment | null {
  const internal = source.getInternalTexture();
  if (!internal?.isReady) return null;
  let bucket = caches.get(engine);
  if (!bucket) {
    const entries = new Map<InternalTexture, Entry>();
    const clearParked = () => {
      for (const [key, item] of [...entries]) {
        if (item.references === 0) dropEntry(entries, key, item);
      }
    };
    const lost = engine.onContextLostObservable.add(clearParked);
    const disposed = engine.onDisposeObservable.addOnce(() => {
      engine.onContextLostObservable.remove(lost);
      for (const [key, item] of [...entries]) dropEntry(entries, key, item);
      caches.delete(engine);
    });
    bucket = { entries, lost, disposed };
    caches.set(engine, bucket);
  }
  const cache = bucket.entries;
  let entry = cache.get(internal);
  if (entry?.failed && entry.references === 0) {
    dropEntry(cache, internal, entry);
    entry = undefined;
  }
  if (!entry) {
    const owned = createFilteredEnvironmentTarget(engine, source.getSize().width);
    if (!owned) return null;
    const created: Entry = {
      owned,
      references: 0,
      parkedTimer: null,
      failed: false,
      ready: filterEnvironment(engine, source, owned),
    };
    // A failed filter is reported to each holder through `ready`, and never stays parked once released.
    void created.ready.catch(() => {
      created.failed = true;
      if (created.references === 0) dropEntry(cache, internal, created);
    });
    entry = created;
    cache.set(internal, entry);
  } else if (entry.parkedTimer !== null) {
    clearTimeout(entry.parkedTimer);
    entry.parkedTimer = null;
  }
  entry.references++;
  const held = entry;
  let released = false;
  return {
    cube: held.owned.cube,
    ready: held.ready,
    release: () => {
      if (released) return;
      released = true;
      if (--held.references !== 0) return;
      const contextLost = Boolean((engine as unknown as { _contextWasLost?: boolean })._contextWasLost);
      if (engine.isDisposed || contextLost || held.failed) {
        dropEntry(cache, internal, held);
        return;
      }
      held.parkedTimer = setTimeout(() => {
        held.parkedTimer = null;
        if (held.references === 0) dropEntry(cache, internal, held);
      }, PARKED_FILTERED_ENVIRONMENT_MS);
    },
  };
}

/** Write the GGX-filtered radiance of a ready `source` cube into every mip of `into`. */
export async function filterEnvironment(
  engine: AbstractEngine,
  source: BaseTexture,
  into: FilteredEnvironmentTarget,
): Promise<void> {
  const { target, size } = into;
  const defines = [`#define NUM_SAMPLES ${FILTER_SAMPLES}u`];
  if (source.gammaSpace) defines.push("#define GAMMA_INPUT");
  const effect = new EffectWrapper({
    engine,
    name: "hdrFiltering",
    vertexShader: "hdrFiltering",
    fragmentShader: "hdrFiltering",
    samplerNames: ["inputTexture"],
    uniformNames: ["vSampleDirections", "vWeights", "up", "right", "front", "vFilteringInfo", "hdrScale", "alphaG"],
    useShaderStore: true,
    defines,
    shaderLanguage: 0,
    extraInitializationsAsync: async () => {
      await Promise.all([import("@babylonjs/core/Shaders/hdrFiltering.vertex"), import("@babylonjs/core/Shaders/hdrFiltering.fragment")]);
    },
  });
  let renderer: EffectRenderer | undefined;
  try {
    await effect.effect.whenCompiledAsync();
    // Retain the compiled hdrFiltering shader on the Engine keep so reflection probes and Scene switches reuse it.
    retainEngineEffect(engine, effect.effect);
    if (!target.texture || source.getInternalTexture() === null) throw new Error("Environment filtering lost its source or target.");
    const sourceWidth = source.getSize().width;
    const sourceMips = Math.floor(Math.log2(sourceWidth)) + 1;
    const mips = Math.log2(size) + 1;
    withDrawingState(engine, () => {
      renderer = new EffectRenderer(engine);
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setColorWrite(true);
      engine.setDepthWrite(false);
      const shader = effect.effect;
      for (let face = 0; face < 6; face++) {
        const [up, right, front] = FACES[face]!;
        for (let lod = 0; lod < mips; lod++) {
          engine.bindFramebuffer(target, face, undefined, undefined, true, lod);
          renderer!.applyEffectWrapper(effect);
          shader.setTexture("inputTexture", source);
          shader.setFloat("hdrScale", 1);
          // Source size and mips: each sample reads the source mip its solid angle covers.
          shader.setFloat2("vFilteringInfo", sourceWidth, sourceMips);
          shader.setFloat3("up", up[0], up[1], up[2]);
          shader.setFloat3("right", right[0], right[1], right[2]);
          shader.setFloat3("front", front[0], front[1], front[2]);
          // Babylon's lod-to-roughness mapping; mip 0 keeps a one-texel lobe so it also downsamples.
          shader.setFloat("alphaG", Math.pow(2, (lod - LOD_GENERATION_OFFSET) / LOD_GENERATION_SCALE) / size);
          renderer!.draw();
        }
      }
    });
  } finally {
    renderer?.dispose();
    effect.dispose();
  }
}
