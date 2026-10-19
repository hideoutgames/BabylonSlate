import {
  BaseTexture,
  CascadedShadowGenerator,
  Constants,
  DirectionalLight,
  PointLight,
  SpotLight,
  Vector3,
  type AbstractEngine,
  type Camera,
  type Effect,
  type InternalTexture,
  type RenderTargetWrapper,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { VolumetricLightingSettings } from "@babylonslate/core";
import {
  sceneEffectLights,
  isClusteredLocalAllowed,
} from "./clustered-light-policy";
import {
  isAuthoredLightEnabled,
  isDirectionalLightExcluded,
  isForwardLightExcluded,
} from "./light-policy";
import { findSceneShadowController } from "./shadow-controller";

export type VolumeLight = DirectionalLight | PointLight | SpotLight;
export type VolumeShadow = {
  kind: "none" | "cube" | "compare" | "cascades";
  cascades: number;
  packed: boolean;
};

/** Babylon's cascaded shadow generator splits at most four cascades; the march's cascade arrays hold that many. */
export const VOLUME_MAX_CASCADES = 4;

/**
 * What each slot samples this frame (`volumeShadow{i}.x` in the march): the kind is a uniform, so a light change never
 * compiles another march. A cube map stores float depth, or RGBA8-packed depth where float targets are unavailable.
 */
export const VOLUME_SHADOW_CODE = { none: 0, compare: 1, cube: 2, packedCube: 3, cascades: 4 } as const;

/**
 * Every slot can compare a single map (sun or spot light) and read a cube map (point light); only the first reads a
 * cascaded map. The one sun that illuminates ranks before every local light, so it always takes the first slot, and
 * the march's samplers stay at 2 × Max Lights + 3 with its depth and source (11 at four lights, within the 16 a
 * fragment stage is guaranteed).
 */
export function volumeSlotSamples(slot: number, kind: VolumeShadow["kind"]): boolean {
  return kind !== "cascades" || slot === 0;
}

/**
 * The index Babylon's `bindShadowLight` appends to its uniform and sampler names for a slot's kind: each kind has its
 * own sampler in every slot, so a slot's samplers never change type.
 */
export function volumeShadowIndex(slot: number, kind: "compare" | "cube" | "cascades"): string {
  return kind === "compare" ? String(slot) : kind === "cube" ? `Cube${slot}` : `Cascades${slot}`;
}

/** The lights taking the march's slots, in slot order (valid below `count`). */
export interface VolumetricSlots {
  readonly lights: (VolumeLight | undefined)[];
  count: number;
}

export function createVolumetricSlots(): VolumetricSlots {
  return { lights: [], count: 0 };
}

// Selection scratch, emptied before each fill returns so no light stays retained.
const picked: (VolumeLight | undefined)[] = [];
const pickedDistance: number[] = [];

/** Whether `a` outranks `b` for a place among the lights taking part: directional lights first, then render
 * priority, then nearest to the camera. */
function outranks(a: VolumeLight, distanceA: number, b: VolumeLight, distanceB: number): boolean {
  return (
    (Number(b instanceof DirectionalLight) - Number(a instanceof DirectionalLight) ||
      b.renderPriority - a.renderPriority ||
      distanceA - distanceB ||
      a.uniqueId - b.uniqueId) < 0
  );
}

/** Slot order: the directional light first (only the first slot reads cascades), then creation. */
function slotsBefore(a: VolumeLight, b: VolumeLight): boolean {
  return (Number(b instanceof DirectionalLight) - Number(a instanceof DirectionalLight) || a.uniqueId - b.uniqueId) < 0;
}

/**
 * Fills `slots` with the lights that take part: the directional light first, then the others by creation. Bounded and
 * deterministic; borrowed cluster children stay eligible. Distance (with directional lights and render priority)
 * chooses which lights take part, not their slots, so lights crossing in distance keep their slots. Allocates nothing
 * once the scratch has grown to the light count.
 */
export function fillVolumetricSlots(
  slots: VolumetricSlots,
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
): void {
  const limit = settings.maxLights;
  const previous = slots.count;
  let count = 0;
  if (scene.lightsEnabled) {
    const lights = sceneEffectLights(scene);
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index]!;
      if (
        !(
          light instanceof DirectionalLight ||
          light instanceof PointLight ||
          light instanceof SpotLight
        ) ||
        !isAuthoredLightEnabled(light) ||
        light.intensity <= 0 ||
        light.isDisposed() ||
        isDirectionalLightExcluded(light) ||
        isForwardLightExcluded(light) ||
        !isClusteredLocalAllowed(scene, light) ||
        (light.parent && !light.parent.isEnabled())
      )
        continue;
      // A parent moved since its world matrix was cached; recomputing an unchanged one would invalidate its subtree.
      if (light.parent && !light.parent.isSynchronized()) light.parent.computeWorldMatrix(true);
      const transformed = light.computeTransformedInformation();
      const distance =
        light instanceof DirectionalLight
          ? -1
          : Vector3.DistanceSquared(
              transformed ? light.transformedPosition : light.position,
              camera.globalPosition,
            );
      if (distance > (settings.maxDistance + light.range) ** 2) continue;
      // Insert among the best `limit` so far, shifting the tail (and dropping the last when full).
      let at = count;
      while (at > 0 && outranks(light, distance, picked[at - 1]!, pickedDistance[at - 1]!)) at--;
      if (at >= limit) continue;
      for (let i = count < limit ? count : limit - 1; i > at; i--) {
        picked[i] = picked[i - 1];
        pickedDistance[i] = pickedDistance[i - 1]!;
      }
      picked[at] = light;
      pickedDistance[at] = distance;
      if (count < limit) count++;
    }
  }
  // Insertion sort into slot order: at most `maxLights` entries.
  for (let i = 0; i < count; i++) {
    const light = picked[i]!;
    picked[i] = undefined;
    let at = i;
    while (at > 0 && slotsBefore(light, slots.lights[at - 1]!)) {
      slots.lights[at] = slots.lights[at - 1];
      at--;
    }
    slots.lights[at] = light;
  }
  slots.count = count;
  for (let i = count; i < previous; i++) slots.lights[i] = undefined;
}

/** Shared by the query below; it keeps no light between calls. */
const queried = createVolumetricSlots();

/** The lights taking part, in slot order. */
export function selectVolumetricLights(
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
): VolumeLight[] {
  fillVolumetricSlots(queried, scene, camera, settings);
  const lights = queried.lights.slice(0, queried.count) as VolumeLight[];
  for (let i = 0; i < queried.count; i++) queried.lights[i] = undefined;
  queried.count = 0;
  return lights;
}

/** The light's admitted map; a standby or released one is none, so the march never binds it. */
export function volumeShadowGenerator(
  scene: Scene,
  light: VolumeLight,
): ShadowGenerator | null {
  return scene.shadowsEnabled && light.shadowEnabled
    ? (findSceneShadowController(scene)?.generator(light) ?? null)
    : null;
}

/** The sampler shape of a light's map, written into `out` (a per-frame caller passes scratch storage). */
function shadowShape(generator: ShadowGenerator | null, out: VolumeShadow): VolumeShadow {
  const map = generator?.getShadowMap();
  if (map?.getInternalTexture() && map.isCube) {
    out.kind = "cube";
    out.cascades = 1;
    out.packed = map.textureType === Constants.TEXTURETYPE_UNSIGNED_BYTE;
  } else if (
    generator &&
    map?.getInternalTexture() &&
    (generator.usePercentageCloserFiltering ||
      generator.useContactHardeningShadow)
  ) {
    const cascaded = generator instanceof CascadedShadowGenerator;
    out.kind = cascaded ? "cascades" : "compare";
    out.cascades = cascaded ? generator.numCascades : 1;
    out.packed = false;
  } else {
    out.kind = "none";
    out.cascades = 0;
    out.packed = false;
  }
  return out;
}

/** The light's current shadow sampler shape, written into `out` (a per-frame caller passes scratch storage). */
export function volumeShadowLayout(
  scene: Scene,
  light: VolumeLight,
  out: VolumeShadow = { kind: "none", cascades: 0, packed: false },
): VolumeShadow {
  return shadowShape(volumeShadowGenerator(scene, light), out);
}

/**
 * One texel of each shadow sampler type, bound to every sampler a slot's kind does not read: a WebGPU bind group needs
 * a texture of the declared type in every binding, and WebGL2 must not leave a released map (or another type) behind
 * on a slot's unit. The depth ones compare like real maps. Never sampled: the slot's kind skips them.
 */
export interface VolumeShadowPlaceholders {
  readonly compare: BaseTexture;
  readonly cube: BaseTexture;
  readonly cascades: BaseTexture;
}

const placeholders = new WeakMap<Scene, VolumeShadowPlaceholders>();

/**
 * The scene's placeholders, created on first use and disposed with the scene. Create them while preparing a graph:
 * allocating a render target inside a pass would rebind the framebuffer it draws to.
 */
export function volumeShadowPlaceholders(scene: Scene): VolumeShadowPlaceholders {
  let owned = placeholders.get(scene);
  if (owned) return owned;
  const engine = scene.getEngine();
  const targets: RenderTargetWrapper[] = [];
  const wrap = (target: RenderTargetWrapper, texture: InternalTexture, name: string) => {
    targets.push(target);
    // The wrapper holds its own reference, so the texture and its render target release independently.
    texture.incrementReferences();
    const placeholder = new BaseTexture(engine, texture);
    placeholder.name = name;
    return placeholder;
  };
  let texel: InternalTexture | undefined;
  const depth = (layers: number, name: string) => {
    const target = engine.createRenderTargetTexture(layers ? { width: 1, height: 1, layers } : { width: 1, height: 1 }, {
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE, format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: name,
    });
    texel ??= target.texture ?? undefined;
    // Engines without depth textures (NullEngine) never sample a map by comparison.
    const texture = engine._features.supportDepthStencilTexture
      ? target.createDepthStencilTexture(Constants.LESS, true, false, 1, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, name)
      : target.texture;
    if (!texture) throw new Error("Volumetric shadow placeholder could not be allocated.");
    return wrap(target, texture, name);
  };
  const cube = (name: string) => {
    const target = engine.createRenderTargetCubeTexture(1, {
      type: cubeShadowType(engine), format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: name,
    });
    // NullEngine leaves its cube target's texture unattached; it draws nothing, so the 2D texel serves there.
    const texture = target.texture ?? texel;
    if (!texture) throw new Error("Volumetric shadow placeholder could not be allocated.");
    return wrap(target, texture, name);
  };
  owned = {
    compare: depth(0, "volumetric-shadow-placeholder"),
    cascades: depth(1, "volumetric-cascade-shadow-placeholder"),
    cube: cube("volumetric-cube-shadow-placeholder"),
  };
  placeholders.set(scene, owned);
  const disposed = owned;
  scene.onDisposeObservable.addOnce(() => {
    disposed.compare.dispose();
    disposed.cube.dispose();
    disposed.cascades.dispose();
    for (const target of targets) target.dispose();
    placeholders.delete(scene);
  });
  return owned;
}

/** The texture type Babylon's shadow generator gives a cube map here, so a placeholder samples like a real map. */
function cubeShadowType(engine: AbstractEngine): number {
  const caps = engine.getCaps();
  if (caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering) return Constants.TEXTURETYPE_HALF_FLOAT;
  if (caps.textureFloatRender && caps.textureFloatLinearFiltering) return Constants.TEXTURETYPE_FLOAT;
  return Constants.TEXTURETYPE_UNSIGNED_BYTE;
}

/**
 * Binds the lights to the march's `slotCount` slots, slot by slot, and the count of lights taking part; slots past it
 * are skipped by the march but still bind placeholders. Each slot's shadow kind and map are resolved here, after the
 * graph's shadow task: maps stay controller-owned and can be replaced, stood by or released during admission, and a
 * light whose map is gone (or that the slot cannot sample) draws unshadowed rather than sample a released map.
 */
export function bindVolumetricLights(
  effect: Effect,
  scene: Scene,
  camera: Camera,
  slots: VolumetricSlots,
  slotCount: number,
  textures: VolumeShadowPlaceholders,
  scratch: VolumeShadow,
): void {
  const count = Math.min(slots.count, slotCount);
  effect.setFloat("volumeLightCount", count);
  for (let i = 0; i < slotCount; i++) {
    const light = i < count ? slots.lights[i] : undefined;
    let generator: ShadowGenerator | null = null;
    let kind: VolumeShadow["kind"] = "none";
    if (light) {
      const transformed = light.computeTransformedInformation();
      const position = transformed ? light.transformedPosition : light.position;
      const directional = light instanceof DirectionalLight;
      const spot = light instanceof SpotLight;
      const direction =
        directional || spot
          ? transformed
            ? light.transformedDirection
            : light.direction
          : Vector3.Forward();
      effect.setFloat4(
        `volumePosition${i}`,
        position.x,
        position.y,
        position.z,
        directional ? 0 : spot ? 2 : 1,
      );
      effect.setFloat4(
        `volumeDirection${i}`,
        direction.x,
        direction.y,
        direction.z,
        spot ? Math.cos(light.angle / 2) : -1,
      );
      const intensity = light.isEnabled() ? light.getScaledIntensity() : 0;
      effect.setFloat4(
        `volumeColor${i}`,
        light.diffuse.r * intensity,
        light.diffuse.g * intensity,
        light.diffuse.b * intensity,
        Math.min(1e6, light.range),
      );
      effect.setFloat2(
        `volumeCone${i}`,
        spot ? Math.cos(light.innerAngle / 2) : 1,
        spot ? light.exponent : 1,
      );
      const min = light.getDepthMinZ(camera);
      effect.setFloat2(`volumeDepth${i}`, min, min + light.getDepthMaxZ(camera));
      generator = volumeShadowGenerator(scene, light);
      const shape = shadowShape(generator, scratch);
      if (volumeSlotSamples(i, shape.kind)) kind = shape.kind;
    }
    const code = kind === "compare" ? VOLUME_SHADOW_CODE.compare
      : kind === "cube" ? (scratch.packed ? VOLUME_SHADOW_CODE.packedCube : VOLUME_SHADOW_CODE.cube)
        : kind === "cascades" ? VOLUME_SHADOW_CODE.cascades : VOLUME_SHADOW_CODE.none;
    effect.setFloat2(`volumeShadow${i}`, code, kind === "cascades" ? scratch.cascades : kind === "none" ? 0 : 1);
    if (kind === "compare") generator!.bindShadowLight(volumeShadowIndex(i, "compare"), effect);
    else effect.setTexture(`shadowTexture${volumeShadowIndex(i, "compare")}`, textures.compare);
    if (kind === "cube") generator!.bindShadowLight(volumeShadowIndex(i, "cube"), effect);
    else effect.setTexture(`shadowTexture${volumeShadowIndex(i, "cube")}`, textures.cube);
    if (i === 0) {
      if (kind === "cascades") generator!.bindShadowLight(volumeShadowIndex(i, "cascades"), effect);
      else effect.setTexture(`shadowTexture${volumeShadowIndex(i, "cascades")}`, textures.cascades);
    }
  }
}
