import {
  Constants,
  CubeTexture,
  EffectRenderer,
  EffectWrapper,
  type AbstractEngine,
  type InternalTexture,
  type RenderTargetWrapper,
} from "@babylonjs/core";
import { withDrawingState } from "./engine-drawing-state";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";

/** Face size of a filtered environment: rough lighting needs no more, and it bounds the filter's GPU work. */
export const FILTERED_ENVIRONMENT_SIZE = 256;
/** Importance samples per texel; each reads the source mip matching its lobe, so few are needed. */
const FILTER_SAMPLES = 256;
// Babylon's PBR maps roughness to a mip through these; the filter writes the matching lobe per mip.
const LOD_GENERATION_SCALE = 0.8;
const LOD_GENERATION_OFFSET = 0;

export interface FilteredEnvironment {
  /** GGX-prefiltered linear cube, usable once `ready` resolves. */
  readonly cube: CubeTexture;
  readonly ready: Promise<void>;
  release(): void;
}

type Entry = {
  cube: CubeTexture;
  target: RenderTargetWrapper;
  lease: ManagedRenderLease;
  ready: Promise<void>;
  references: number;
};
const caches = new WeakMap<AbstractEngine, Map<InternalTexture, Entry>>();

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
  const caps = engine.getCaps();
  if (!internal?.isReady || !engine._features.allowTexturePrefiltering || (!engine.isWebGPU && !caps.textureLOD)) return null;
  let cache = caches.get(engine);
  if (!cache) { cache = new Map(); caches.set(engine, cache); }
  let entry = cache.get(internal);
  if (!entry) {
    const type = caps.textureHalfFloatRender
      ? Constants.TEXTURETYPE_HALF_FLOAT
      : caps.textureFloatRender ? Constants.TEXTURETYPE_FLOAT : null;
    if (type === null) return null;
    const size = filteredSize(source.getSize().width);
    const bytes = cubeBytes(size, type === Constants.TEXTURETYPE_FLOAT ? 16 : 8);
    const lease = beginManagedRenderAllocation(engine, bytes);
    if (!lease) return null;
    let target: RenderTargetWrapper | undefined;
    let cube: CubeTexture | undefined;
    try {
      target = engine.createRenderTargetCubeTexture(size, {
        format: Constants.TEXTUREFORMAT_RGBA,
        type,
        createMipMaps: true,
        generateMipMaps: false,
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
        label: "Filtered environment",
      });
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
    const owned = { cube, target, lease, references: 0 } as Entry;
    owned.ready = filter(engine, source, target, size);
    // A failed filter is reported to each holder through `ready`.
    void owned.ready.catch(() => {});
    entry = owned;
    cache.set(internal, entry);
  }
  entry.references++;
  const held = entry;
  let released = false;
  return {
    cube: held.cube,
    ready: held.ready,
    release: () => {
      if (released) return;
      released = true;
      if (--held.references !== 0) return;
      if (cache.get(internal) === held) cache.delete(internal);
      held.cube.dispose();
      held.target.dispose();
      void releaseManagedRenderLeaseAfterDisposal(engine, held.lease);
    },
  };
}

async function filter(
  engine: AbstractEngine,
  source: CubeTexture,
  target: RenderTargetWrapper,
  size: number,
): Promise<void> {
  const defines = [`#define NUM_SAMPLES ${FILTER_SAMPLES}u`];
  if (source.gammaSpace) defines.push("#define GAMMA_INPUT");
  const wgsl = engine.isWebGPU;
  const effect = new EffectWrapper({
    engine,
    name: "hdrFiltering",
    vertexShader: "hdrFiltering",
    fragmentShader: "hdrFiltering",
    samplerNames: ["inputTexture"],
    uniformNames: ["vSampleDirections", "vWeights", "up", "right", "front", "vFilteringInfo", "hdrScale", "alphaG"],
    useShaderStore: true,
    defines,
    shaderLanguage: wgsl ? 1 : 0,
    extraInitializationsAsync: async () => {
      if (wgsl) await Promise.all([import("@babylonjs/core/ShadersWGSL/hdrFiltering.vertex"), import("@babylonjs/core/ShadersWGSL/hdrFiltering.fragment")]);
      else await Promise.all([import("@babylonjs/core/Shaders/hdrFiltering.vertex"), import("@babylonjs/core/Shaders/hdrFiltering.fragment")]);
    },
  });
  let renderer: EffectRenderer | undefined;
  try {
    await effect.effect.whenCompiledAsync();
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
