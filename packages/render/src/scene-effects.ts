import { Color4, ImageProcessingConfiguration } from "@babylonjs/core";
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
}

/** Composed effect chain: authored stack output → bloom → image processing →
 * FXAA → output. Null means the project renders exactly as it always has. */
export interface SceneEffectsPlan {
  /** Half-float linear intermediates and the linear→display conversion. */
  sceneLinear: boolean;
  bloom: RenderEffectsSettings["bloom"] | null;
  imageProcessing: SceneEffectsImageProcessingPlan | null;
  fxaa: boolean;
}

/**
 * Resolve the normalized settings into the renderable chain. CEL renders
 * display-space by construction, so the Scene Linear stage (and therefore
 * tone mapping, exposure and contrast) only applies to PBR projects; vignette,
 * bloom and FXAA remain available in every mode.
 */
export function planSceneEffects(
  effects: RenderEffectsSettings,
  mode: RenderMode,
  enabled = true,
): SceneEffectsPlan | null {
  if (!enabled) return null;
  const sceneLinear =
    mode === "pbr" && effects.colorPipeline.mode === "sceneLinear";
  const bloom = effects.bloom.enabled ? effects.bloom : null;
  const vignette = effects.vignette.enabled ? effects.vignette : null;
  // The display stage is required to convert linear HDR scene color, and is
  // the only pass which can apply the vignette on either pipeline.
  const imageProcessing =
    sceneLinear || vignette ? { sceneLinear, vignette } : null;
  const fxaa = effects.fxaa;
  if (!sceneLinear && !bloom && !imageProcessing && !fxaa) return null;
  return { sceneLinear, bloom, imageProcessing, fxaa };
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
): string {
  return enabled ? `${mode}${JSON.stringify(effects)}` : "off";
}
