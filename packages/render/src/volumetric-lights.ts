import {
  CascadedShadowGenerator,
  Constants,
  DirectionalLight,
  PointLight,
  SpotLight,
  Vector3,
  type Camera,
  type Effect,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { VolumetricLightingSettings } from "@haptic/core";
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
import type { ShadowSamplerPlaceholders as VolumeShadowPlaceholders } from "./shadow-sampler-placeholders";

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
 * the march declares 2 × Max Lights + 2 samplers with its depth (10 at four lights, within the 16 a fragment stage is
 * guaranteed).
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

/**
 * The map a march drawn for `camera` samples for `light`. Only an admitted map counts: a standby or released one is
 * none, so the march never binds it. A view with its own sun maps (a Full Quality capture, `attachView`) samples the
 * sun map fitted to its camera, whose cascade matrices and splits match its view; one whose mirror the ledger refused
 * samples the scene view's map, as its materials do. Local maps are shared by every view.
 */
function volumeShadowGenerator(
  scene: Scene,
  light: VolumeLight,
  camera: Camera,
): ShadowGenerator | null {
  if (!scene.shadowsEnabled || !light.shadowEnabled) return null;
  const controller = findSceneShadowController(scene);
  // viewBoundGenerator alone falls back to the light's bound map, which can be on standby.
  if (!controller?.generator(light)) return null;
  return controller.viewBoundGenerator(light, camera);
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

export {
  shadowSamplerPlaceholders as volumeShadowPlaceholders,
  type ShadowSamplerPlaceholders as VolumeShadowPlaceholders,
} from "./shadow-sampler-placeholders";

/**
 * Binds the lights to the march's `slotCount` slots, slot by slot, and the count of lights taking part; slots past it
 * are skipped by the march but still bind placeholders. Each slot's shadow kind and map are resolved here, after the
 * graph's shadow task: maps stay controller-owned and can be replaced, stood by or released during admission, and a
 * light whose map is gone (or that the slot cannot sample) draws unshadowed rather than sample a released map. A sun's
 * map is the one fitted to `camera`, the view the march draws (`volumeShadowGenerator`).
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
      generator = volumeShadowGenerator(scene, light, camera);
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
