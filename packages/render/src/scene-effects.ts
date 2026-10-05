import { Color4, ImageProcessingConfiguration, type BaseTexture } from "@babylonjs/core";
import type {
  RenderEffectsSettings,
  RenderEffectsToneMapping,
  RenderMode,
} from "@babylonslate/core";

/** Display Color stage inputs. The vignette also runs in Legacy Display and
 * CEL, where exposure, contrast and tone mapping stay at identity. */
export interface SceneEffectsImageProcessingPlan {
  /** Linear HDR scene color resolves through the configured display stage. */
  sceneLinear: boolean;
  vignette: RenderEffectsSettings["vignette"] | null;
  /** Ready LUT strip graded after tone mapping, in display space. */
  colorGrading: BaseTexture | null;
}

/** Scene state beyond the project settings that changes the compiled chain. */
export interface SceneEffectsInputs {
  /** Local Fog Volumes request the volumetric pass with zero scene density. */
  fogVolumesPresent?: boolean;
  /** The project's LUT, once loaded; null leaves color grading off. */
  colorGradingTexture?: BaseTexture | null;
}

/** Composed effect chain: authored stack output → ambient occlusion →
 * reflections → volumetric lighting → bloom → image processing →
 * FXAA → output. Null means the project renders exactly as it always has. */
export interface SceneEffectsPlan {
  /** Half-float linear intermediates and the linear→display conversion. */
  sceneLinear: boolean;
  bloom: RenderEffectsSettings["bloom"] | null;
  imageProcessing: SceneEffectsImageProcessingPlan | null;
  fxaa: boolean;
  temporalAntiAliasing: RenderEffectsSettings["temporalAntiAliasing"] | null;
  ambientOcclusion: RenderEffectsSettings["ambientOcclusion"] | null;
  reflections: RenderEffectsSettings["reflections"] | null;
  volumetricLighting: RenderEffectsSettings["volumetricLighting"] | null;
}

/**
 * Resolve the normalized settings into the renderable chain. CEL renders
 * display-space by construction, so the Scene Linear stage (and therefore
 * tone mapping, exposure and contrast) only applies to PBR projects; vignette,
 * bloom and FXAA remain available in every mode. Ambient occlusion and
 * reflections are PBR-only so CEL keeps its hard-stepped shading.
 */
export function planSceneEffects(
  effects: RenderEffectsSettings,
  mode: RenderMode,
  enabled = true,
  inputs: SceneEffectsInputs = {},
): SceneEffectsPlan | null {
  if (!enabled) return null;
  const fogVolumesPresent = inputs.fogVolumesPresent === true;
  const sceneLinear =
    mode === "pbr" && effects.colorPipeline.mode === "sceneLinear";
  const bloom = effects.bloom.enabled ? effects.bloom : null;
  const vignette = effects.vignette.enabled ? effects.vignette : null;
  const colorGrading = effects.colorGrading.enabled ? inputs.colorGradingTexture ?? null : null;
  // The display stage is required to convert linear HDR scene color, and is
  // the only pass which can apply the vignette or LUT on either pipeline.
  const imageProcessing =
    sceneLinear || vignette || colorGrading ? { sceneLinear, vignette, colorGrading } : null;
  const fxaa = effects.fxaa;
  const temporalAntiAliasing = effects.temporalAntiAliasing.enabled ? effects.temporalAntiAliasing : null;
  const ambientOcclusion = mode === "pbr" && effects.ambientOcclusion.enabled ? effects.ambientOcclusion : null;
  const reflections = mode === "pbr" && effects.reflections.enabled ? effects.reflections : null;
  const volumetricLighting = effects.volumetricLighting.enabled ? effects.volumetricLighting
    : fogVolumesPresent ? { ...effects.volumetricLighting, enabled: true, density: 0 } : null;
  if (!sceneLinear && !bloom && !imageProcessing && !fxaa && !temporalAntiAliasing && !ambientOcclusion && !reflections && !volumetricLighting)
    return null;
  return { sceneLinear, bloom, imageProcessing, fxaa, temporalAntiAliasing, ambientOcclusion, reflections, volumetricLighting };
}

const TONE_MAPPING_TYPES: Record<RenderEffectsToneMapping, number> = {
  none: ImageProcessingConfiguration.TONEMAPPING_STANDARD,
  standard: ImageProcessingConfiguration.TONEMAPPING_STANDARD,
  aces: ImageProcessingConfiguration.TONEMAPPING_ACES,
  neutral: ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL,
};

/**
 * The Display Color configuration. Every consumer must build a dedicated
 * instance: a thin or camera ImageProcessingPostProcess owns its configuration
 * and resets applyByPostProcess when it is disposed, so sharing the Scene's
 * configuration would corrupt per-material image processing.
 *
 * Babylon's image-processing shader always finishes in toGammaSpace. With
 * fromLinearSpace it converts linear HDR to display while applying the
 * configured processing; without it the pass decodes display-space input,
 * applies the enabled processing and re-encodes, which keeps CEL and Legacy
 * Display output identity while allowing the vignette.
 */
export function sceneEffectsImageProcessingConfiguration(
  effects: RenderEffectsSettings,
  plan: SceneEffectsImageProcessingPlan,
): ImageProcessingConfiguration {
  const config = new ImageProcessingConfiguration();
  const linear = plan.sceneLinear;
  config.toneMappingEnabled = linear && effects.toneMapping !== "none";
  config.toneMappingType = linear
    ? TONE_MAPPING_TYPES[effects.toneMapping]
    : ImageProcessingConfiguration.TONEMAPPING_STANDARD;
  config.exposure = linear ? effects.exposure : 1;
  config.contrast = linear ? effects.contrast : 1;
  const vignette = plan.vignette;
  if (vignette) {
    config.vignetteEnabled = true;
    config.vignetteWeight = vignette.weight;
    config.vignetteColor = new Color4(
      vignette.color[0],
      vignette.color[1],
      vignette.color[2],
      1,
    );
    config.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
  }
  if (plan.colorGrading) {
    // A 3D LUT: Babylon's 2D-strip polyfill is GLSL-only on Babylon 9.20.
    config.colorGradingTexture = plan.colorGrading;
    config.colorGradingEnabled = true;
  }
  return config;
}

/**
 * A change in this key invalidates every compiled effect instance and the
 * prepared graph: settings are baked into pass defines and texture types.
 */
export function sceneEffectsKey(
  effects: RenderEffectsSettings,
  mode: RenderMode,
  enabled: boolean,
  inputs: SceneEffectsInputs = {},
): string {
  if (!enabled) return "off";
  const lut = effects.colorGrading.enabled ? inputs.colorGradingTexture?.uniqueId : undefined;
  return `${mode}${JSON.stringify(effects)}${inputs.fogVolumesPresent ? ":fogVolumes" : ""}${lut === undefined ? "" : `:lut${lut}`}`;
}
