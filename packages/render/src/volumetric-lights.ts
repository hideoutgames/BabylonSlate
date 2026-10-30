import {
  DirectionalLight,
  PointLight,
  SpotLight,
  Vector3,
  type Camera,
  type Effect,
  type Scene,
} from "@babylonjs/core";
import type { VolumetricLightingSettings } from "@haptic/core";
import { HAPTIC_SHADOW_ATLAS } from "./haptic-lighting-shader";
import { bindHapticLights, hapticShadowViews } from "./haptic-lights";
import {
  isAuthoredLightEnabled,
  isDirectionalLightExcluded,
  isForwardLightExcluded,
} from "./light-policy";
import { shadowAtlasTexture } from "./shadow-atlas";

export type VolumeLight = DirectionalLight | PointLight | SpotLight;
export type VolumeShadow = {
  kind: "none" | "cube" | "compare" | "cascades";
  /** The light's views of the atlas (a spot light's one, a point light's faces, the sun's cascades). */
  cascades: number;
  /** The light's first view. */
  first: number;
};

/**
 * What each slot samples this frame (`volumeShadow{i}.x` in the march): the kind is a uniform, so a light change never
 * compiles another march. A spot light's view is `compare`, a point light's faces `cube` and the sun's cascades
 * `cascades`.
 */
export const VOLUME_SHADOW_CODE = { none: 0, compare: 1, cube: 2, cascades: 3 } as const;

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
    const lights = scene.lights;
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

const views = { first: 0, count: 0 };

/** A light's shadow, its views of the atlas (`hapticShadowViews`), written into `out`. */
function shadowShape(scene: Scene, light: VolumeLight, out: VolumeShadow): VolumeShadow {
  const shadowed = hapticShadowViews(scene, light, views);
  out.kind = !shadowed ? "none" : light instanceof DirectionalLight ? "cascades" : light instanceof SpotLight ? "compare" : "cube";
  out.cascades = shadowed ? views.count : 0;
  out.first = shadowed ? views.first : 0;
  return out;
}

/**
 * Binds the lights to the march's `slotCount` slots, slot by slot, and the count of lights taking part; slots past it
 * are skipped by the march. Each slot's shadow is resolved here, after the graph's shadow task: its light's views of
 * the atlas, read from the light block (`volumeShadow{i}`: kind, views, first view), which holds the rendering camera's
 * sun; a light with no views drawn draws unshadowed.
 */
export function bindVolumetricLights(
  effect: Effect,
  scene: Scene,
  camera: Camera,
  slots: VolumetricSlots,
  slotCount: number,
  scratch: VolumeShadow,
): void {
  const count = Math.min(slots.count, slotCount);
  effect.setFloat("volumeLightCount", count);
  bindHapticLights(scene, effect);
  effect.setDepthStencilTexture(HAPTIC_SHADOW_ATLAS, shadowAtlasTexture(scene));
  for (let i = 0; i < slotCount; i++) {
    const light = i < count ? slots.lights[i] : undefined;
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
      kind = shadowShape(scene, light, scratch).kind;
    }
    const code = VOLUME_SHADOW_CODE[kind];
    effect.setFloat4(`volumeShadow${i}`, code, kind === "none" ? 0 : scratch.cascades, kind === "none" ? 0 : scratch.first, 0);
  }
}
