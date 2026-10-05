import type { EngineCapabilities } from "@babylonjs/core";
import type { WaterQuality } from "@babylonslate/core";

export type WaterDeviceCapabilities = Pick<EngineCapabilities, "textureFloatRender" | "textureHalfFloatRender">;

/** View state a device limit depends on, beside the engine's capabilities. */
export interface WaterDeviceView {
  /**
   * The Scene Linear colour pipeline is active (materials write linear HDR): its planar reflection target is
   * RGBA16F, so Planar then needs half-float render targets as the scene copy does.
   */
  readonly sceneLinear?: boolean;
}

export interface WaterQualityDeviceClamp {
  /** Values this device can honour; the requested object itself when no value changed. */
  readonly quality: Readonly<WaterQuality>;
  /**
   * Planar reflections may use their Screen Space fallback on non-flat water.
   * False when reflections are not Planar, or when the device cannot allocate
   * the half-float scene copy the march samples; such water reflects the sky.
   */
  readonly screenSpaceFallback: boolean;
  /** One reason per clamped feature, reported by Play readback. Empty when nothing was clamped. */
  readonly limits: readonly string[];
}

/**
 * The single device gate for project Water quality: effective value = asset
 * intent ∧ quality cap ∧ this clamp. Water rendering gates on this result, not
 * on the requested values. Effect owners extend it when a feature needs
 * another capability, so readback and rendering agree on what ran.
 */
export function clampWaterQualityToDevice(
  quality: Readonly<WaterQuality>,
  caps: WaterDeviceCapabilities,
  view: WaterDeviceView = {},
): WaterQualityDeviceClamp {
  const limits: string[] = [];
  let effective = quality;
  let screenSpaceFallback = quality.reflections === "planar";
  if (quality.fft && !caps.textureFloatRender) {
    effective = { ...effective, fft: false };
    limits.push("FFT Ocean Detail needs float render targets; water keeps its analytic waves.");
  }
  // The scene copy that Refraction and the screen-space march sample is RGBA16F.
  if (!caps.textureHalfFloatRender) {
    if (quality.refraction) {
      effective = { ...effective, refraction: false };
      limits.push("Water Refraction needs half-float render targets; water keeps its blended surface.");
    }
    if (quality.reflections === "screenSpace") {
      effective = { ...effective, reflections: "sky" };
      limits.push("Screen Space water reflections need half-float render targets; water reflects the sky only.");
    }
    if (quality.reflections === "planar" && view.sceneLinear) {
      // Scene Linear mirrors into RGBA16F and its Screen Space fallback marches the RGBA16F scene copy: neither can
      // run, so every body reflects the sky.
      effective = { ...effective, reflections: "sky" };
      screenSpaceFallback = false;
      limits.push("Planar water reflections need half-float render targets in Scene Linear; water reflects the sky only.");
    } else if (quality.reflections === "planar") {
      screenSpaceFallback = false;
      limits.push("Planar water reflections fall back to Sky Only on non-flat water without half-float render targets.");
    }
  }
  return { quality: effective, screenSpaceFallback, limits };
}
