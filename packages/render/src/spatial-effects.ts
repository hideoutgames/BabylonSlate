import { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Matrix, Vector2 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { ThinSSRPostProcess } from "@babylonjs/core/PostProcesses/thinSSRPostProcess";
import { ThinSSRBlurPostProcess } from "@babylonjs/core/PostProcesses/thinSSRBlurPostProcess";
// The stages' vertex shader, from the shader store.
import "@babylonjs/core/Shaders/postprocess.vertex";
import type { SceneEffectsPlan } from "./scene-effects";
import {
  sceneRenderingSettings,
  resolveSceneRenderingQuality,
} from "./render-settings";
import {
  bindVolumetricLights,
  createVolumetricSlots,
  fillVolumetricSlots,
  type VolumeShadow,
} from "./volumetric-lights";
import { volumetricShader } from "./volumetric-shader";
import { ambientOcclusionBlurShader, ambientOcclusionShader } from "./ambient-occlusion-shader";
import { spatialComposeShader } from "./spatial-compose-shader";
import { retireOwnedEffect } from "./owned-effect-retirement";
import { beginManagedRenderAllocation } from "./managed-render-resources";
import { bindFogVolumes, hasFogVolumes, selectFogVolumes } from "./fog-volumes";
import type { EffectCompileFailure } from "./effect-compile-failure";
import { HAPTIC_SHADOW_ATLAS } from "./haptic-lighting-shader";

/** Delay native define setters until all settings/camera flags are configured.
 * Babylon otherwise overwrites (and leaks) each intermediate Effect reference. */
const pendingDefines = new WeakMap<
  EffectWrapper,
  Parameters<EffectWrapper["updateEffect"]>
>();
class PreparedSSR extends ThinSSRPostProcess {
  override updateEffect(
    ...args: Parameters<EffectWrapper["updateEffect"]>
  ): void {
    pendingDefines.set(this, args);
  }
  compile(): void {
    super.updateEffect(...(pendingDefines.get(this) ?? []));
    pendingDefines.delete(this);
  }
}
export interface SpatialStage {
  wrapper: EffectWrapper;
  scale: number;
  /**
   * The stage target's format (half float): RGBA unless every reader of the stage's output takes one channel, as the
   * occlusion march and blurs, whose single-channel targets sample as (value, 0, 0, 1).
   */
  format?: number;
  /** What it reads as `textureSampler`: the previous stage's output, or with "scene" the chain's input colour. */
  source?: "scene";
  /** Earlier stages' outputs it also samples, bilinear: sampler name to stage index. */
  reads?: Record<string, number>;
  /** It writes the chain's colour (the compose): skipped, it passes its source through. */
  color?: boolean;
  geometry: boolean;
  /**
   * Evaluated before each frame: true when running this stage would leave the
   * chain's color unchanged. The graph then skips it (a `color` stage passes its
   * source through; another draws nothing, so only an idle-capable reader may
   * read its output), and skips the geometry pass once no running stage reads
   * it. Stages that share a condition share one function, which the graph
   * evaluates once per frame.
   */
  idle?: () => boolean;
  bind(effect: Effect): void;
}

export function spatialEffectsUnsupported(scene: Scene): string | undefined {
  const caps = scene.getEngine().getCaps();
  if (
    !caps.drawBuffersExtension ||
    !caps.texelFetch ||
    (caps.maxDrawBuffers ?? 0) < 4 ||
    !caps.textureHalfFloatRender ||
    !caps.textureFloatRender ||
    !caps.depthTextureExtension
  )
    return "Ambient occlusion, reflections, volumetric lighting and Screen-Space Shadows require four render targets, half-float textures and depth sampling.";
  return undefined;
}

/**
 * Screen-Space Shadows march at the render size divided by this, rounded up, each texel from the top-left pixel of its
 * block (`screen-shadows.ts`); the light block's read (`hapticScreenShadowLit`) divides its pixel by the same factor.
 */
export const SCREEN_SHADOW_SCALE = 2;

/** The plan has at least one stage composed by the spatial geometry chain. */
export function hasSpatialEffects(plan: SceneEffectsPlan | null): plan is SceneEffectsPlan {
  return !!plan && !!(plan.ambientOcclusion || plan.reflections || plan.volumetricLighting || plan.screenShadows);
}

/** Reserve MRTs, color/depth and effect targets before any native allocation.
 * Scaled targets use rounded dimensions, just like their allocation recipes. */
export function reserveSpatialEffects(
  scene: Scene,
  plan: SceneEffectsPlan,
  width: number,
  height: number,
  /** The graph's own scene colour and depth samples (MSAA), each sample counted beside the resolved texture. */
  sceneSamples = 1,
) {
  const pixels = width * height;
  const quality =
    resolveSceneRenderingQuality(scene).postprocessing.resolutionScale;
  const scaledBytes = (scale: number, pixelBytes = 8) =>
    Math.max(1, Math.round(width * Math.max(0.25, scale * quality))) *
    Math.max(1, Math.round(height * Math.max(0.25, scale * quality))) *
    pixelBytes;
  // The graph's scene color/depth and geometry Z.
  let bytes = pixels * 20;
  // Multisampled scene colour (at most half-float) and depth32 store every sample.
  if (sceneSamples > 1) bytes += pixels * sceneSamples * (8 + 4);
  // Reflections and occlusion share the encoded world-normal attachment.
  if (plan.ambientOcclusion && !plan.reflections) bytes += pixels * 4;
  // The one RGBA16F compose of them all.
  if (plan.ambientOcclusion || plan.reflections || plan.volumetricLighting) bytes += pixels * 8;
  // Occlusion's R16F march and blurs.
  if (plan.ambientOcclusion) bytes += scaledBytes(plan.ambientOcclusion.resolutionScale, 2) * 3;
  // The normal and reflectivity attachments, and the trace and its blurs.
  if (plan.reflections) bytes += pixels * 8 + scaledBytes(plan.reflections.resolutionScale) * 3;
  if (plan.volumetricLighting) bytes += scaledBytes(plan.volumetricLighting.resolutionScale);
  // Screen-Space Shadows' half-resolution RG16F target and the caster mark's second channel of the geometry Z (at most
  // float).
  if (plan.screenShadows)
    bytes += Math.ceil(width / SCREEN_SHADOW_SCALE) * Math.ceil(height / SCREEN_SHADOW_SCALE) * 4 + pixels * 4;
  return beginManagedRenderAllocation(scene.getEngine(), bytes);
}

/**
 * The settings, camera and size baked into a prepared graph's effect tasks. No light is among them: the volumetric
 * march binds the lights nearest the camera, with their shadow kinds, through uniforms each frame.
 */
export function liveSceneEffectsKey(
  scene: Scene,
  camera = scene.activeCamera,
): string {
  const state = sceneRenderingSettings(scene);
  const plan = state.effectsPlan;
  if (!camera || !hasSpatialEffects(plan)) return state.effectsKey;
  const size = camera.outputRenderTarget?.getSize();
  const engine = scene.getEngine();
  return `${state.effectsKey}:${camera.uniqueId}:${camera.mode}:${size?.width ?? engine.getRenderWidth(true)}x${size?.height ?? engine.getRenderHeight(true)}:${resolveSceneRenderingQuality(scene).postprocessing.resolutionScale}`;
}

type VolumetricPlan = NonNullable<SceneEffectsPlan["volumetricLighting"]>;

/**
 * Without scene density the volumetric march only fogs authored Fog Volumes: none in front of this camera leaves
 * every pixel unfogged, whatever the lights.
 */
function volumetricMarchIdle(
  scene: Scene,
  camera: Camera,
  volume: VolumetricPlan,
  localVolumes = hasFogVolumes(scene),
): boolean {
  return volume.density <= 0 && (!localVolumes || selectFogVolumes(scene, camera).length === 0);
}

/**
 * `fragment`'s key in the shader store, which holds it from its first use: its source's FNV-1a hash and length, so a
 * source always has the same key and Babylon's compiled Effect of a key is always that source's.
 */
function storedFragment(fragment: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fragment.length; index++) hash = Math.imul(hash ^ fragment.charCodeAt(index), 0x01000193);
  const key = `hapticSpatialStage${(hash >>> 0).toString(16)}x${fragment.length}`;
  ShaderStore.GetShadersStore(ShaderLanguage.GLSL)[`${key}FragmentShader`] ??= fragment;
  return key;
}

/**
 * A stage's Effect, drawn from the shader store under its fragment source's key (`storedFragment`). Babylon builds an
 * inline source's Effect with its constructor, outside the Engine's Effect cache and without uniform buffers, so each
 * graph build linked every stage again and two stages of the same code (the occlusion blurs) linked twice; from the
 * store, stages of one source and defines share one cached Effect. Babylon calls the `onError` of the Effect's first
 * creator only, so each stage also hears its failure from the Effect itself, until the Effect compiles.
 */
export function customWrapper(
  scene: Scene,
  name: string,
  fragment: string,
  uniforms: string[],
  samplers: string[],
  failure?: EffectCompileFailure,
  uniformBuffers: string[] = [],
): EffectWrapper {
  const wrapper = new EffectWrapper({
    name,
    engine: scene.getEngine(),
    useAsPostProcess: true,
    shaderLanguage: 0,
    useShaderStore: true,
    // The store's own post-process vertex shader.
    vertexShader: undefined,
    fragmentShader: storedFragment(fragment),
    uniforms,
    samplers,
    uniformBuffers,
    onError: failure?.for(name),
  });
  const effect = wrapper.effect;
  if (failure && effect && !effect.isReady()) {
    const report = failure.for(name);
    const failed = () => Boolean(effect.getCompilationError()) && effect.allFallbacksProcessed();
    if (failed()) report(effect, effect.getCompilationError());
    else {
      const observer = effect.onErrorObservable.add(() => {
        if (failed()) report(effect, effect.getCompilationError());
      });
      effect.onCompileObservable.addOnce(() => effect.onErrorObservable.remove(observer));
    }
  }
  return wrapper;
}

/** Spatial stages and their uniform contracts for the FrameGraph. */
export function createSpatialStages(
  scene: Scene,
  camera: Camera,
  plan: SceneEffectsPlan,
  width: number,
  height: number,
  failure?: EffectCompileFailure,
): SpatialStage[] {
  if (spatialEffectsUnsupported(scene)) return [];
  const stages: SpatialStage[] = [];
  const wrappers: EffectWrapper[] = [];
  const own = <T extends EffectWrapper>(wrapper: T): T => {
    wrappers.push(wrapper);
    return wrapper;
  };
  const engine = scene.getEngine();
  const quality =
    resolveSceneRenderingQuality(scene).postprocessing.resolutionScale;
  const reflections = plan.reflections;
  // The one compose's inputs, which each effect adds: earlier stages' outputs, samplers, uniforms and their binding.
  const reads: Record<string, number> = {};
  const composeSamplers = ["depthSampler"];
  const composeUniforms: string[] = [];
  const composeBinds: ((effect: Effect) => void)[] = [];
  let fogIdle: (() => boolean) | undefined;
  try {
    const occlusion = plan.ambientOcclusion;
    if (occlusion) {
      const scale = Math.max(0.25, occlusion.resolutionScale * quality);
      const texelWidth = 1 / Math.max(1, Math.round(width * scale)),
        texelHeight = 1 / Math.max(1, Math.round(height * scale));
      const march = own(
        customWrapper(
          scene,
          "Scene Ambient Occlusion",
          ambientOcclusionShader(occlusion.samples),
          ["aoProjection", "aoInverseProjection", "aoView", "aoSettings", "aoCamera", "aoTexelSize"],
          ["depthSampler", "normalSampler"],
          failure,
        ),
      );
      const inverseProjection = Matrix.Identity();
      // The march and blurs write visibility to every colour channel, and each reader (the blurs, the compose) takes
      // red alone: one half-float channel holds it, at a quarter of RGBA16F's bytes and fetch bandwidth.
      stages.push({
        wrapper: march,
        scale,
        format: Constants.TEXTUREFORMAT_R,
        geometry: true,
        bind: (effect) => {
          const projection = camera.getProjectionMatrix();
          projection.invertToRef(inverseProjection);
          effect.setMatrix("aoProjection", projection);
          effect.setMatrix("aoInverseProjection", inverseProjection);
          effect.setMatrix("aoView", camera.getViewMatrix());
          effect.setFloat4(
            "aoSettings",
            occlusion.radius,
            occlusion.strength,
            Math.min(occlusion.maxDistance, camera.maxZ || occlusion.maxDistance),
            occlusion.radius * 0.025,
          );
          effect.setFloat2(
            "aoCamera",
            scene.useRightHandedSystem ? -1 : 1,
            camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0,
          );
          effect.setFloat2("aoTexelSize", texelWidth, texelHeight);
        },
      });
      for (const [axis, x, y] of [["X", texelWidth, 0], ["Y", 0, texelHeight]] as const) {
        const blur = own(
          customWrapper(
            scene,
            `Scene Ambient Occlusion Blur ${axis}`,
            ambientOcclusionBlurShader(),
            ["aoBlurStep"],
            ["depthSampler"],
            failure,
          ),
        );
        stages.push({
          wrapper: blur,
          scale,
          format: Constants.TEXTUREFORMAT_R,
          geometry: true,
          bind: (effect) => effect.setFloat2("aoBlurStep", x, y),
        });
      }
      reads.aoSampler = stages.length - 1;
      composeUniforms.push("aoTexelSize");
      composeBinds.push((effect) => effect.setFloat2("aoTexelSize", texelWidth, texelHeight));
    }
    if (reflections) {
      const scale = Math.max(0.25, reflections.resolutionScale * quality);
      const ssr = own(
        new PreparedSSR("Scene Reflections", scene, {
          blockCompilation: true,
          onError: failure?.for("Scene Reflections"),
        }),
      );
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
      // It traces the scene colour before occlusion: the compose applies both at once.
      stages.push({ wrapper: ssr, scale, source: "scene", geometry: true, bind: () => {} });
      for (const [axis, direction] of [
        ["X", new Vector2(1, 0)],
        ["Y", new Vector2(0, 1)],
      ] as const) {
        const blur = own(
          new ThinSSRBlurPostProcess(
            `Scene Reflections Blur ${axis}`,
            engine,
            direction,
            0.03,
            { onError: failure?.for(`Scene Reflections Blur ${axis}`) },
          ),
        );
        blur.textureWidth = Math.max(1, Math.round(width * scale));
        blur.textureHeight = Math.max(1, Math.round(height * scale));
        stages.push({ wrapper: blur, scale, geometry: false, bind: () => {} });
      }
      reads.reflectionSampler = stages.length - 1;
      composeSamplers.push("normalSampler", "reflectivitySampler");
      composeUniforms.push("reflectionTerms", "projection", "invProjectionMatrix", "view");
      const inverseProjection = Matrix.Identity();
      composeBinds.push((effect) => {
        // Babylon's combiner's: no specular falloff, and its reflectivity threshold.
        effect.setFloat4("reflectionTerms", reflections.strength, 1, 0.04, 0);
        const projection = camera.getProjectionMatrix();
        projection.invertToRef(inverseProjection);
        effect.setMatrix("projection", projection);
        effect.setMatrix("invProjectionMatrix", inverseProjection);
        effect.setMatrix("view", camera.getViewMatrix());
      });
    }
    const volume = plan.volumetricLighting;
    if (volume) {
      const localVolumes = hasFogVolumes(scene);
      // One march per settings: Max Lights slots, each taking any light type and shadow kind through uniforms.
      const slotCount = volume.maxLights;
      const uniforms = [
        "inverseProjection",
        "inverseView",
        "volumeView",
        "volumeSettings",
        "volumeCamera",
        "volumeHeight",
        "volumeShadowOffset",
        "volumeLightCount",
        ...(localVolumes ? ["fogVolumeCount", "fogVolumeInverse", "fogVolumeParameters"] : []),
      ];
      // The slots' shadows are the light block's views of its atlas.
      const samplers = ["depthSampler", HAPTIC_SHADOW_ATLAS];
      for (let i = 0; i < slotCount; i++) {
        uniforms.push(
          `volumePosition${i}`,
          `volumeDirection${i}`,
          `volumeColor${i}`,
          `volumeCone${i}`,
          `volumeDepth${i}`,
          `volumeShadow${i}`,
        );
      }
      const march = own(
        customWrapper(
          scene,
          "Scene Volumetric Lighting",
          volumetricShader(
            slotCount,
            volume.steps,
            localVolumes,
          ),
          uniforms,
          samplers,
          failure,
          ["HapticLights"],
        ),
      );
      const inverseProjection = Matrix.Identity(),
        inverseView = Matrix.Identity();
      const slots = createVolumetricSlots();
      const scratch: VolumeShadow = { kind: "none", cascades: 0, first: 0 };
      // The compose reads this frame's answer, which the graph's idle sync evaluated before the frame.
      let marchIdle = false;
      fogIdle = () => (marchIdle = volumetricMarchIdle(scene, camera, volume, localVolumes));
      stages.push({
        wrapper: march,
        scale: Math.max(0.25, volume.resolutionScale * quality),
        // It reads no colour: the scene's keeps no other stage's output alive until it draws.
        source: "scene",
        geometry: true,
        idle: fogIdle,
        bind: (effect) => {
          camera.getProjectionMatrix().invertToRef(inverseProjection);
          camera.getViewMatrix().invertToRef(inverseView);
          effect.setMatrix("inverseProjection", inverseProjection);
          effect.setMatrix("inverseView", inverseView);
          effect.setMatrix("volumeView", camera.getViewMatrix());
          // Babylon rebases shadow matrices in large-world mode. Ray positions and
          // light attenuation stay in world space; only shadow lookup is rebased.
          const offset = scene.floatingOriginOffset;
          effect.setFloat3(
            "volumeShadowOffset",
            scene.floatingOriginMode ? offset.x : 0,
            scene.floatingOriginMode ? offset.y : 0,
            scene.floatingOriginMode ? offset.z : 0,
          );
          effect.setFloat4(
            "volumeSettings",
            volume.density,
            volume.intensity,
            volume.maxDistance,
            volume.anisotropy,
          );
          effect.setFloat2("volumeHeight", volume.height, volume.heightFalloff);
          effect.setFloat4(
            "volumeCamera",
            camera.minZ,
            camera.maxZ,
            scene.useRightHandedSystem ? -1 : 1,
            camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0,
          );
          // Selected as the march draws: the frame has moved the camera (inputs, animation) and drawn its shadow
          // maps by now, so the nearest lights and their maps are this frame's.
          // Lights near a Fog Volume past Volumetric Distance still light it.
          const fogReach = localVolumes ? bindFogVolumes(effect, scene, camera) : 0;
          fillVolumetricSlots(slots, scene, camera, volume, Math.max(volume.maxDistance, fogReach));
          bindVolumetricLights(effect, scene, camera, slots, slotCount, scratch);
        },
      });
      const scale = Math.max(0.25, volume.resolutionScale * quality);
      reads.fogSampler = stages.length - 1;
      composeUniforms.push("fogTexelSize", "cameraFar", "fogActive");
      composeBinds.push((effect) => {
        effect.setFloat2(
          "fogTexelSize",
          1 / Math.max(1, Math.round(width * scale)),
          1 / Math.max(1, Math.round(height * scale)),
        );
        effect.setFloat("cameraFar", Math.min(65000, camera.maxZ || 65000));
        effect.setFloat("fogActive", marchIdle ? 0 : 1);
      });
    }
    if (plan.ambientOcclusion || reflections || volume) {
      const compose = own(
        customWrapper(
          scene,
          "Scene Effects Compose",
          spatialComposeShader({
            ambientOcclusion: !!plan.ambientOcclusion,
            reflections: reflections
              ? { orthographic: camera.mode === Camera.ORTHOGRAPHIC_CAMERA, rightHanded: scene.useRightHandedSystem }
              : null,
            volumetricLighting: !!volume,
            linear: plan.sceneLinear,
          }),
          composeUniforms,
          [...composeSamplers, ...Object.keys(reads)],
          failure,
        ),
      );
      stages.push({
        wrapper: compose,
        scale: 1,
        source: "scene",
        reads,
        color: true,
        geometry: true,
        // Fog alone composes nothing while its march idles; with another effect the compose skips only the fog's term.
        idle: plan.ambientOcclusion || reflections ? undefined : fogIdle,
        bind: (effect) => { for (const bind of composeBinds) bind(effect); },
      });
    }
    return stages;
  } catch (error) {
    for (const wrapper of wrappers) {
      const retirement = retireOwnedEffect(wrapper.effect, () =>
        wrapper.dispose(),
      );
      void retirement.completion.catch(() => {});
      void retirement.released.catch(() => {});
    }
    throw error;
  }
}
