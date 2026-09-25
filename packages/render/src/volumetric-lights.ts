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

/** Bounded, deterministic selection; borrowed cluster children stay eligible. */
export function selectVolumetricLights(
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
): VolumeLight[] {
  if (!scene.lightsEnabled) return [];
  const candidates: { light: VolumeLight; distance: number }[] = [];
  for (const light of sceneEffectLights(scene)) {
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
    light.parent?.computeWorldMatrix(true);
    const transformed = light.computeTransformedInformation();
    const distance =
      light instanceof DirectionalLight
        ? -1
        : Vector3.DistanceSquared(
            transformed ? light.transformedPosition : light.position,
            camera.globalPosition,
          );
    if (distance > (settings.maxDistance + light.range) ** 2) continue;
    candidates.push({ light, distance });
  }
  candidates.sort(
    (a, b) =>
      Number(b.light instanceof DirectionalLight) -
        Number(a.light instanceof DirectionalLight) ||
      b.light.renderPriority - a.light.renderPriority ||
      a.distance - b.distance ||
      a.light.uniqueId - b.light.uniqueId,
  );
  return candidates.slice(0, settings.maxLights).map(({ light }) => light);
}

export function volumeShadowGenerator(
  scene: Scene,
  light: VolumeLight,
): ShadowGenerator | null {
  return scene.shadowsEnabled && light.shadowEnabled
    ? (findSceneShadowController(scene)?.generator(light) ?? null)
    : null;
}

export function volumeShadowLayout(
  scene: Scene,
  light: VolumeLight,
): VolumeShadow {
  const generator = volumeShadowGenerator(scene, light);
  const map = generator?.getShadowMap();
  if (map?.isCube)
    return {
      kind: "cube",
      cascades: 1,
      packed: map.textureType === Constants.TEXTURETYPE_UNSIGNED_BYTE,
    };
  if (
    generator &&
    map &&
    (generator.usePercentageCloserFiltering ||
      generator.useContactHardeningShadow)
  )
    return {
      kind:
        generator instanceof CascadedShadowGenerator ? "cascades" : "compare",
      cascades:
        generator instanceof CascadedShadowGenerator
          ? generator.numCascades
          : 1,
      packed: false,
    };
  return { kind: "none", cascades: 0, packed: false };
}

/** Sampler topology changes reprepare shaders; motion/color never recompile. */
export function volumetricLayoutKey(
  scene: Scene,
  camera: Camera,
  settings: VolumetricLightingSettings,
): string {
  return selectVolumetricLights(scene, camera, settings)
    .map((light) => {
      const layout = volumeShadowLayout(scene, light);
      return `${light.uniqueId}:${layout.kind}:${layout.cascades}:${Number(layout.packed)}`;
    })
    .join(",");
}

export function bindVolumetricLights(
  effect: Effect,
  scene: Scene,
  camera: Camera,
  lights: readonly VolumeLight[],
): void {
  for (let i = 0; i < lights.length; i++) {
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
    // and bind the current map here, after the graph's managed shadow task.
    const generator = volumeShadowGenerator(scene, light);
    generator?.bindShadowLight(String(i), effect);
    const min = light.getDepthMinZ(camera);
    effect.setFloat2(`volumeDepth${i}`, min, min + light.getDepthMaxZ(camera));
  }
}
