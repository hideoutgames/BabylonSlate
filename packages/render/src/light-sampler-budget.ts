import { RectAreaLight, SpotLight, type Light, type Scene } from "@babylonjs/core";
import { isManagedClusteredLight } from "./clustered-light-policy";

/** Existing material/environment headroom, shared by direct lights and shadows. */
export const MATERIAL_SAMPLER_RESERVE = 8;

export function lightingSamplerCapacity(scene: Scene): number {
  return Math.max(0, scene.getEngine().getCaps().maxTexturesImageUnits - MATERIAL_SAMPLER_RESERVE);
}

/** LTC tables share two shader bindings; emission still has one binding per light. */
export function lightSamplerCost(scene: Scene, light: Light, hasArea: boolean): number {
  if (light instanceof RectAreaLight) return (hasArea ? 0 : 2) + Number(!!light.emissionTexture);
  if (isManagedClusteredLight(scene, light)) return scene.getEngine().isWebGPU ? 1 : 2;
  if (light instanceof SpotLight) return Number(!!light.projectionTexture) + Number(!!light.iesProfileTexture);
  return 0;
}

export function lightSamplerCount(scene: Scene, lights: Iterable<Light>): number {
  let count = 0, hasArea = false;
  for (const light of lights) {
    count += lightSamplerCost(scene, light, hasArea);
    hasArea ||= light instanceof RectAreaLight;
  }
  return count;
}

/** Shadows spend only the sampler headroom left by admitted direct lighting. */
export function remainingShadowSamplers(scene: Scene): number {
  return Math.max(0, lightingSamplerCapacity(scene) - lightSamplerCount(scene, scene.lights.filter((light) => light.isEnabled() && light.intensity > 0)));
}
