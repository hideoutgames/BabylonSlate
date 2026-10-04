import type { EngineCapabilities } from "@babylonjs/core";
import type { WaterQuality } from "@babylonslate/core";

export type WaterDeviceCapabilities = Pick<EngineCapabilities, "textureFloatRender" | "textureHalfFloatRender">;

export interface WaterQualityDeviceClamp {
  /** Values this device can honour; the requested object itself when nothing was clamped. */
  readonly quality: Readonly<WaterQuality>;
  /** One reason per clamped feature, reported by Play readback. Empty when nothing was clamped. */
  readonly limits: readonly string[];
}

/**
 * The single device gate for project Water quality: effective value = asset
 * intent ∧ quality cap ∧ this clamp. Effect owners extend it when a feature
 * needs another capability, so readback and rendering agree on what ran.
 */
export function clampWaterQualityToDevice(
  quality: Readonly<WaterQuality>,
  caps: WaterDeviceCapabilities,
): WaterQualityDeviceClamp {
  const limits: string[] = [];
  let effective = quality;
  if (quality.fft && !caps.textureFloatRender) {
    effective = { ...effective, fft: false };
    limits.push("FFT Ocean Detail needs float render targets; water keeps its analytic waves.");
  }
  if (!caps.textureHalfFloatRender) {
    if (quality.refraction) {
      effective = { ...effective, refraction: false };
      limits.push("Water Refraction needs half-float render targets; water keeps its blended surface.");
    }
    if (quality.reflections === "screenSpace") {
      effective = { ...effective, reflections: "sky" };
      limits.push("Screen Space water reflections need half-float render targets; water reflects the sky only.");
    }
  }
  return { quality: effective, limits };
}
