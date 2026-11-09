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

/**
 * Parts of water the `waterdebug` console command switches off for a Play session, to measure what each costs (the
 * Feature Test Check's Water Breakdown): every water surface (`water`), its depth pre-pass (`prepass`), its lighting
 * (`lighting`: drawn unlit), the shadows it receives (`shadows`), its per-pixel waves (`waves`: normals, crest foam and
 * subsurface light; the vertex displacement stays) and its shore, contact and edge foam (`foam`).
 */
export const WATER_DEBUG_PARTS = ["water", "prepass", "lighting", "shadows", "waves", "foam"] as const;
export type WaterDebugPart = (typeof WATER_DEBUG_PARTS)[number];
