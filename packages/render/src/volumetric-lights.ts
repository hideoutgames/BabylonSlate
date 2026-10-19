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

/**
 * What the march's shader bakes in about its lights: the shadow sampler shape of each slot, in slot order. A slot
 * reads its light's type, position, direction, color and range from uniforms, so any light whose shadow has the slot's
 * shape can take it, and the layout names no light.
 */
export type VolumetricLayout = readonly VolumeShadow[];

/** The lights taking the march's slots, in slot order, with their current shadow shapes (both valid below `count`). */
export interface VolumetricSlots {
  readonly lights: (VolumeLight | undefined)[];
  readonly shapes: VolumeShadow[];
  count: number;
}

export function createVolumetricSlots(): VolumetricSlots {
  return { lights: [], shapes: [], count: 0 };
}

const SHADOW_KIND_RANK = { none: 0, compare: 1, cube: 2, cascades: 3 } as const;

/** The canonical order of slot shapes: sampler kind, then cascade count, then packed depth. */
export function compareVolumeShadows(a: VolumeShadow, b: VolumeShadow): number {
  return (
    SHADOW_KIND_RANK[a.kind] - SHADOW_KIND_RANK[b.kind] ||
    a.cascades - b.cascades ||
    Number(a.packed) - Number(b.packed)
  );
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

/**
 * Fills `slots` with the lights that take part, in the canonical slot order: by shadow shape, then by creation. Bounded
 * and deterministic; borrowed cluster children stay eligible. Distance (with directional lights and render priority)
 * chooses which lights take part, not their slots, so lights crossing in distance or swapping places change neither the
 * shader layout nor the slots' shapes. Allocates nothing once the scratch has grown to the light count.
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
  for (let i = 0; i < count; i++) {
    const light = picked[i]!;
    picked[i] = undefined;
    slots.lights[i] = light;
    volumeShadowLayout(scene, light, (slots.shapes[i] ??= { kind: "none", cascades: 0, packed: false }));
  }
  slots.count = count;
  for (let i = count; i < previous; i++) slots.lights[i] = undefined;
  // Insertion sort by shape, then creation: at most `maxLights` entries, each moving its light and shape together.
  for (let i = 1; i < count; i++) {
    const light = slots.lights[i]!;
    const shape = slots.shapes[i]!;
    let at = i;
    while (
      at > 0 &&
      (compareVolumeShadows(shape, slots.shapes[at - 1]!) || light.uniqueId - slots.lights[at - 1]!.uniqueId) < 0
    ) {
      slots.lights[at] = slots.lights[at - 1];
      slots.shapes[at] = slots.shapes[at - 1]!;
      at--;
    }
    slots.lights[at] = light;
    slots.shapes[at] = shape;
  }
}

/** Whether the shapes in `slots` are exactly the layout, slot by slot. */
export function volumetricSlotsMatch(slots: VolumetricSlots, layout: VolumetricLayout): boolean {
  if (slots.count !== layout.length) return false;
  for (let i = 0; i < slots.count; i++) if (compareVolumeShadows(slots.shapes[i]!, layout[i]!) !== 0) return false;
  return true;
}

/**
 * Whether these lights, in slot order, still have the shadow shapes the layout was compiled for: none disposed, and
 * each light's map is the sampler kind of its slot. `scratch` receives the current shapes.
 */
export function lightsFillVolumetricLayout(
  scene: Scene,
  lights: readonly (VolumeLight | undefined)[],
  layout: VolumetricLayout,
  scratch: VolumeShadow,
): boolean {
  for (let i = 0; i < layout.length; i++) {
    const light = lights[i];
    if (!light || light.isDisposed() || compareVolumeShadows(volumeShadowLayout(scene, light, scratch), layout[i]!) !== 0)
      return false;
  }
  return true;
}

/** The layout of the shapes in `slots`, as storage of its own. */
export function volumetricLayoutOf(slots: VolumetricSlots): VolumeShadow[] {
  return slots.shapes.slice(0, slots.count).map(({ kind, cascades, packed }) => ({ kind, cascades, packed }));
}

/** Shared by the queries below; it keeps no light between calls. */
const queried = createVolumetricSlots();
function releaseQueried(): void {
  for (let i = 0; i < queried.count; i++) queried.lights[i] = undefined;
  queried.count = 0;
}

/** The lights taking part, in slot order. */
export function selectVolumetricLights(
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
): VolumeLight[] {
  fillVolumetricSlots(queried, scene, camera, settings);
  const lights = queried.lights.slice(0, queried.count) as VolumeLight[];
  releaseQueried();
  return lights;
}

/** The layout the march would be compiled for now. */
export function volumetricLayout(
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
): VolumeShadow[] {
  fillVolumetricSlots(queried, scene, camera, settings);
  const layout = volumetricLayoutOf(queried);
  releaseQueried();
  return layout;
}

/** Whether a march compiled for `built` can bind the lights taking part now. Allocation-free. */
export function volumetricLayoutMatches(
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
  built: VolumetricLayout,
): boolean {
  fillVolumetricSlots(queried, scene, camera, settings);
  const matches = volumetricSlotsMatch(queried, built);
  releaseQueried();
  return matches;
}

export function volumeShadowGenerator(
  scene: Scene,
  light: VolumeLight,
): ShadowGenerator | null {
  return scene.shadowsEnabled && light.shadowEnabled
    ? (findSceneShadowController(scene)?.generator(light) ?? null)
    : null;
}

/** The light's current shadow sampler layout, written into `out` (a per-frame caller passes scratch storage). */
export function volumeShadowLayout(
  scene: Scene,
  light: VolumeLight,
  out: VolumeShadow = { kind: "none", cascades: 0, packed: false },
): VolumeShadow {
  const generator = volumeShadowGenerator(scene, light);
  const map = generator?.getShadowMap();
  if (map?.isCube) {
    out.kind = "cube";
    out.cascades = 1;
    out.packed = map.textureType === Constants.TEXTURETYPE_UNSIGNED_BYTE;
  } else if (
    generator &&
    map &&
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

/** Binds the lights to the layout's slots in order; each light's shadow shape must be its slot's. */
export function bindVolumetricLights(
  effect: Effect,
  scene: Scene,
  camera: Camera,
  lights: readonly (VolumeLight | undefined)[],
  layout: VolumetricLayout,
): void {
  for (let i = 0; i < layout.length; i++) {
    const light = lights[i]!;
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
    // Maps remain controller-owned and can be replaced during admission. Resolve
    // and bind the current map here, after the graph's managed shadow task. A slot
    // compiled without a shadow has no sampler to bind, whatever map its light has.
    if (layout[i]!.kind !== "none") volumeShadowGenerator(scene, light)?.bindShadowLight(String(i), effect);
    const min = light.getDepthMinZ(camera);
    effect.setFloat2(`volumeDepth${i}`, min, min + light.getDepthMaxZ(camera));
  }
}
