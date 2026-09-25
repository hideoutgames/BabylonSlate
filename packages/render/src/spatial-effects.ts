import {
  Camera, Constants, EffectWrapper, Matrix, Vector2,
  type Effect, type Scene,
} from "@babylonjs/core";
import { ThinSSRPostProcess } from "@babylonjs/core/PostProcesses/thinSSRPostProcess";
import { ThinSSRBlurPostProcess } from "@babylonjs/core/PostProcesses/thinSSRBlurPostProcess";
import { ThinSSRBlurCombinerPostProcess } from "@babylonjs/core/PostProcesses/thinSSRBlurCombinerPostProcess";
import { postprocessVertexShader } from "@babylonjs/core/Shaders/postprocess.vertex";
import { postprocessVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/postprocess.vertex";
import type { SceneEffectsPlan } from "./scene-effects";
import { sceneRenderingSettings, resolveSceneRenderingQuality } from "./render-settings";
import { bindVolumetricLights, selectVolumetricLights, volumetricLayoutKey, volumeShadowLayout } from "./volumetric-lights";
import { volumetricShader, volumetricCompositeShader } from "./volumetric-shader";
import { retireOwnedEffect } from "./owned-effect-retirement";
import { beginManagedRenderAllocation } from "./managed-render-resources";

/** Delay native define setters until all settings/camera flags are configured.
 * Babylon otherwise overwrites (and leaks) each intermediate Effect reference. */
const pendingDefines = new WeakMap<EffectWrapper, Parameters<EffectWrapper["updateEffect"]>>();
class PreparedSSR extends ThinSSRPostProcess {
  override updateEffect(...args: Parameters<EffectWrapper["updateEffect"]>): void { pendingDefines.set(this, args); }
  compile(): void { super.updateEffect(...(pendingDefines.get(this) ?? [])); pendingDefines.delete(this); }
}
class PreparedSSRCombine extends ThinSSRBlurCombinerPostProcess {
  override updateEffect(...args: Parameters<EffectWrapper["updateEffect"]>): void { pendingDefines.set(this, args); }
  compile(): void {
    const args = pendingDefines.get(this) ?? [];
    // Babylon's combiner omits the orthographic define used by its view-position helper.
    if (this.camera?.mode === Camera.ORTHOGRAPHIC_CAMERA) args[0] = `${args[0] ?? ""}\n#define ORTHOGRAPHIC_CAMERA\n`;
    if (this.camera?.getScene().useRightHandedSystem) args[0] = `${args[0] ?? ""}\n#define SSRAYTRACE_RIGHT_HANDED_SCENE\n`;
    super.updateEffect(...args);
    pendingDefines.delete(this);
  }
}

export interface SpatialStage {
  wrapper: EffectWrapper;
  scale: number;
  /** Index of the stage whose input is the full-resolution color to compose. */
  mainInput?: number;
  geometry: boolean;
  bind(effect: Effect): void;
}

export function spatialEffectsUnsupported(scene: Scene): string | undefined {
  const caps = scene.getEngine().getCaps();
  if (!caps.drawBuffersExtension || !caps.texelFetch || (caps.maxDrawBuffers ?? 0) < 4 ||
    !caps.textureHalfFloatRender || !caps.textureFloatRender || !caps.depthTextureExtension)
    return "Reflections and volumetric lighting require four render targets, half-float textures and depth sampling.";
  return undefined;
}

/** Reserve MRTs, color/depth and effect targets before any native allocation.
 * Scaled targets use rounded dimensions, just like their allocation recipes. */
export function reserveSpatialEffects(scene: Scene, plan: SceneEffectsPlan, width: number, height: number, native: boolean) {
  const pixels = width * height;
  const quality = resolveSceneRenderingQuality(scene).postprocessing.resolutionScale;
  const scaledBytes = (scale: number) => Math.max(1, Math.round(width * Math.max(0.25, scale * quality))) *
    Math.max(1, Math.round(height * Math.max(0.25, scale * quality))) * 8;
  // Native includes its half-float prepass color, R32 depth, padded depth/stencil
  // and a full-size PP input. Graph includes its scene color/depth and geometry Z.
  let bytes = pixels * (native ? 28 : 20);
  if (plan.reflections) bytes += pixels * 16 + scaledBytes(plan.reflections.resolutionScale) * 3;
  if (plan.volumetricLighting) bytes += pixels * 8 + scaledBytes(plan.volumetricLighting.resolutionScale);
  return beginManagedRenderAllocation(scene.getEngine(), bytes);
}

export function liveSceneEffectsKey(scene: Scene, camera = scene.activeCamera): string {
  const state = sceneRenderingSettings(scene);
  const plan = state.effectsPlan;
  if (!camera || !plan || (!plan.reflections && !plan.volumetricLighting)) return state.effectsKey;
  const size = camera.outputRenderTarget?.getSize();
  const engine = scene.getEngine();
  return `${state.effectsKey}:${camera.uniqueId}:${camera.mode}:${size?.width ?? engine.getRenderWidth(true)}x${size?.height ?? engine.getRenderHeight(true)}:${resolveSceneRenderingQuality(scene).postprocessing.resolutionScale}:${
    plan.volumetricLighting ? volumetricLayoutKey(scene, camera, plan.volumetricLighting) : ""
  }`;
}

function customWrapper(scene: Scene, name: string, fragment: string, uniforms: string[], samplers: string[]): EffectWrapper {
  const wgsl = scene.getEngine().isWebGPU;
  return new EffectWrapper({
    name, engine: scene.getEngine(), useAsPostProcess: true,
    shaderLanguage: wgsl ? 1 : 0, useShaderStore: false,
    vertexShader: (wgsl ? postprocessVertexShaderWGSL : postprocessVertexShader).shader,
    fragmentShader: fragment, uniforms, samplers,
  });
}

/** Identical stages and uniform contracts on camera and FrameGraph paths. */
export function createSpatialStages(scene: Scene, camera: Camera, plan: SceneEffectsPlan, width: number, height: number): SpatialStage[] {
  if (spatialEffectsUnsupported(scene)) return [];
  const stages: SpatialStage[] = [];
  const wrappers: EffectWrapper[] = [];
  const own = <T extends EffectWrapper>(wrapper: T): T => { wrappers.push(wrapper); return wrapper; };
  const engine = scene.getEngine();
  const quality = resolveSceneRenderingQuality(scene).postprocessing.resolutionScale;
  const reflections = plan.reflections;
  try {
  if (reflections) {
    const scale = Math.max(0.25, reflections.resolutionScale * quality);
    const ssr = own(new PreparedSSR("Scene Reflections", scene, { blockCompilation: true }));
    ssr.camera = camera;
    ssr.maxSteps = reflections.maxSteps;
    ssr.maxDistance = reflections.maxDistance;
    ssr.step = 2;
    ssr.thickness = reflections.thickness;
    ssr.strength = reflections.strength;
    ssr.useBlur = true;
    ssr.useFresnel = true;
    ssr.normalsAreInWorldSpace = true;
    ssr.normalsAreUnsigned = true;
    ssr.inputTextureColorIsInGammaSpace = !plan.sceneLinear;
    ssr.generateOutputInGammaSpace = false;
    ssr.textureWidth = width;
    ssr.textureHeight = height;
    ssr.compile();
    stages.push({ wrapper: ssr, scale, geometry: true, bind: () => {} });
    for (const [axis, direction] of [["X", new Vector2(1, 0)], ["Y", new Vector2(0, 1)]] as const) {
      const blur = own(new ThinSSRBlurPostProcess(`Scene Reflections Blur ${axis}`, engine, direction, 0.03));
      blur.textureWidth = Math.max(1, Math.round(width * scale));
      blur.textureHeight = Math.max(1, Math.round(height * scale));
      stages.push({ wrapper: blur, scale, geometry: false, bind: () => {} });
    }
    const combine = own(new PreparedSSRCombine("Scene Reflections Compose", engine, { blockCompilation: true }));
    combine.camera = camera;
    combine.useFresnel = true;
    combine.normalsAreInWorldSpace = true;
    combine.normalsAreUnsigned = true;
    combine.strength = reflections.strength;
    combine.inputTextureColorIsInGammaSpace = !plan.sceneLinear;
    combine.generateOutputInGammaSpace = !plan.sceneLinear;
    combine.compile();
    stages.push({ wrapper: combine, scale: 1, mainInput: 0, geometry: true, bind: () => {} });
  }
  const volume = plan.volumetricLighting;
  if (volume) {
    const lights = selectVolumetricLights(scene, camera, volume);
    const shadows = lights.map((light) => volumeShadowLayout(scene, light));
    const uniforms = ["inverseProjection", "inverseView", "volumeView", "volumeSettings", "volumeCamera", "volumeShadowOffset"];
    const samplers = ["depthSampler"];
    shadows.forEach((shadow, i) => {
      uniforms.push(`volumePosition${i}`, `volumeDirection${i}`, `volumeColor${i}`, `volumeCone${i}`, `volumeDepth${i}`, `lightMatrix${i}`, `viewFrustumZ${i}`);
      if (shadow.kind !== "none") samplers.push(`shadowTexture${i}`);
    });
    const march = own(customWrapper(scene, "Scene Volumetric Lighting", volumetricShader(
      engine.isWebGPU, shadows, volume.steps, engine.isNDCHalfZRange, engine.useReverseDepthBuffer,
    ), uniforms, samplers));
    const inverseProjection = Matrix.Identity(), inverseView = Matrix.Identity();
    const mainInput = stages.length;
    stages.push({ wrapper: march, scale: Math.max(0.25, volume.resolutionScale * quality), geometry: true, bind: (effect) => {
      camera.getProjectionMatrix().invertToRef(inverseProjection);
      camera.getViewMatrix().invertToRef(inverseView);
      effect.setMatrix("inverseProjection", inverseProjection);
      effect.setMatrix("inverseView", inverseView);
      effect.setMatrix("volumeView", camera.getViewMatrix());
      // Babylon rebases shadow matrices in large-world mode. Ray positions and
      // light attenuation stay in world space; only shadow lookup is rebased.
      const offset = scene.floatingOriginOffset;
      effect.setFloat3("volumeShadowOffset", scene.floatingOriginMode ? offset.x : 0,
        scene.floatingOriginMode ? offset.y : 0, scene.floatingOriginMode ? offset.z : 0);
      effect.setFloat4("volumeSettings", volume.density, volume.intensity, volume.maxDistance, volume.anisotropy);
      effect.setFloat4("volumeCamera", camera.minZ, camera.maxZ, scene.useRightHandedSystem ? -1 : 1, camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0);
      bindVolumetricLights(effect, scene, camera, lights);
    } });
    const scale = Math.max(0.25, volume.resolutionScale * quality);
    const compose = own(customWrapper(scene, "Scene Volumetric Compose", volumetricCompositeShader(engine.isWebGPU, plan.sceneLinear), ["fogTexelSize", "cameraFar"], ["mainSampler", "depthSampler"]));
    stages.push({ wrapper: compose, scale: 1, mainInput, geometry: true, bind: (effect) => {
      effect.setFloat2("fogTexelSize", 1 / Math.max(1, Math.round(width * scale)), 1 / Math.max(1, Math.round(height * scale)));
      effect.setFloat("cameraFar", Math.min(65000, camera.maxZ || 65000));
    } });
  }
  return stages;
  } catch (error) {
    for (const wrapper of wrappers) {
      const retirement = retireOwnedEffect(wrapper.effect, () => wrapper.dispose());
      void retirement.completion.catch(() => {});
      void retirement.released.catch(() => {});
    }
    throw error;
  }
}

export function spatialGeometryTypes(plan: SceneEffectsPlan): number[] {
  return [Constants.PREPASS_DEPTH_TEXTURE_TYPE, ...(plan.reflections ? [Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE] : [])];
}
