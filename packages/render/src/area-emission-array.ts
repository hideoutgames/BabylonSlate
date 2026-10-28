import { Constants, RawTexture2DArray, type BaseTexture, type Light, type Scene } from "@babylonjs/core";
import type { AreaEmissionPixels } from "@haptic/assets";
import { AREA_EMISSION_TEXTURE_BYTES, areaEmissionResourceKey } from "./area-emission-resource";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";

/**
 * Lighting plan: rect area lights' prepared emissions (`area-emission-resource.ts`, one fixed size) as layers of one
 * always-bound 2D texture array, so a light gaining or changing its emission uploads a layer and compiles nothing.
 */

type Layers = { texture: RawTexture2DArray; keys: string[]; wanted: string; lease: ManagedRenderLease | null };
const scenes = new WeakMap<Scene, Layers>();
const emissions = new WeakMap<Light, AreaEmissionPixels>();

/** The prepared emission a rect light draws with on the lighting plan's path, which keeps no texture per light. */
export function setRectLightEmission(light: Light, pixels: AreaEmissionPixels | undefined): void {
  if (pixels) emissions.set(light, pixels);
  else emissions.delete(light);
}

export function rectLightEmission(light: Light): AreaEmissionPixels | undefined {
  return emissions.get(light);
}

/** One white texel, bound while no rect light has an emission in the array. */
function empty(scene: Scene, wanted: string): Layers {
  const texture = new RawTexture2DArray(new Uint8Array([255, 255, 255, 255]), 1, 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE);
  texture.name = "haptic:areaEmission:none";
  return { texture, keys: [], wanted, lease: null };
}

function build(scene: Scene, used: readonly AreaEmissionPixels[], wanted: string): Layers | null {
  const engine = scene.getEngine();
  const bytes = AREA_EMISSION_TEXTURE_BYTES * used.length;
  const lease = beginManagedRenderAllocation(engine, bytes);
  if (!lease) return null;
  const { width, height } = used[0]!.metadata;
  const layer = width * height * 4;
  const data = new Uint8Array(layer * used.length);
  used.forEach((pixels, index) => data.set(pixels.rgba, layer * index));
  let texture: RawTexture2DArray | undefined;
  try {
    texture = new RawTexture2DArray(data, width, height, used.length, Constants.TEXTUREFORMAT_RGBA, scene, true, false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    texture.name = "haptic:areaEmission";
    texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    lease.commit([{ handle: texture.getInternalTexture()!, bytes, category: "areaLight" }]);
  } catch (error) {
    texture?.dispose();
    void releaseManagedRenderLeaseAfterDisposal(engine, lease);
    throw error;
  }
  return { texture, keys: used.map(areaEmissionResourceKey), wanted, lease };
}

function release(scene: Scene, layers: Layers): void {
  layers.texture.dispose();
  if (layers.lease) void releaseManagedRenderLeaseAfterDisposal(scene.getEngine(), layers.lease);
}

function sceneLayers(scene: Scene): Layers {
  let layers = scenes.get(scene);
  if (!layers) {
    layers = empty(scene, "");
    scenes.set(scene, layers);
    scene.onDisposeObservable.addOnce(() => {
      release(scene, scenes.get(scene)!);
      scenes.delete(scene);
    });
  }
  return layers;
}

/**
 * The layer each of `lights` draws its emission from into `layers`, -1 for none: the first `cap` distinct emissions
 * in light order each take a layer of the array, rebuilt (an upload, no compile) when that set changes. A light past
 * the cap, or every light when the memory budget refuses the array, draws its flat colour.
 */
export function syncAreaEmissionLayers(scene: Scene, lights: readonly Light[], cap: number, layers: number[]): void {
  const used: AreaEmissionPixels[] = [];
  const keys: string[] = [];
  for (const light of lights) {
    const pixels = emissions.get(light);
    if (!pixels || keys.length === cap) continue;
    const key = areaEmissionResourceKey(pixels);
    if (keys.includes(key)) continue;
    keys.push(key);
    used.push(pixels);
  }
  let current = sceneLayers(scene);
  const wanted = keys.join("|");
  if (current.wanted !== wanted) {
    const next = (used.length ? build(scene, used, wanted) : null) ?? empty(scene, wanted);
    release(scene, current);
    scenes.set(scene, next);
    current = next;
  }
  layers.length = 0;
  for (const light of lights) {
    const pixels = emissions.get(light);
    layers.push(pixels ? current.keys.indexOf(areaEmissionResourceKey(pixels)) : -1);
  }
}

/** The texture array the block samples, always bound. */
export function areaEmissionTexture(scene: Scene): BaseTexture {
  return sceneLayers(scene).texture;
}
