import type { Scene } from "@babylonjs/core/scene";
import type { CelShadingOverrides, RenderEffectsOverrides, ShadowOverrides } from "@haptic/core";
import {
  updateSceneRenderingSettings,
  type RenderShadingSettings,
} from "./render-settings";
import { syncSceneLighting } from "./scene-lighting";
import { syncEnvironmentLighting } from "./environment-lighting";

/**
 * Shared by world hosts and asset previews. Graph Materials follow the render mode themselves (`cel-surface.ts`);
 * nothing replaces a Scene's materials.
 */
export function setSceneRenderSettings(
  scene: Scene,
  project?: RenderShadingSettings,
  overrides?: CelShadingOverrides,
  shadowOverrides?: ShadowOverrides,
  effectsOverrides?: RenderEffectsOverrides,
): void {
  updateSceneRenderingSettings(scene, project, overrides, shadowOverrides, undefined, effectsOverrides);
  syncEnvironmentLighting(scene);
  syncSceneLighting(scene);
}
