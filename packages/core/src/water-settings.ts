/**
 * Water Blend Distance (metres) of a project that never set it: water bodies this close morph into one surface
 * (`evaluateWaterBlend`). 0 turns blending off.
 */
export const DEFAULT_WATER_BLEND_DISTANCE = 8;
export const MAX_WATER_BLEND_DISTANCE = 64;

/** Project water settings, stored with the render settings (`RenderProjectSettings.water`) and quality-independent. */
export interface WaterProjectSettings {
  /** Water Blend Distance: metres within which water bodies blend into one surface, for rendering and queries alike. */
  blendDistance: number;
}

export function normalizeWaterBlendDistance(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_WATER_BLEND_DISTANCE, value))
    : DEFAULT_WATER_BLEND_DISTANCE;
}

export function normalizeWaterProjectSettings(value: unknown): WaterProjectSettings {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<WaterProjectSettings> : undefined;
  return { blendDistance: normalizeWaterBlendDistance(v?.blendDistance) };
}
