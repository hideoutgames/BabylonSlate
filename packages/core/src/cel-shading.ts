/** Native surface lighting; PBR remains the default for legacy projects. */
export type RenderMode = "pbr" | "cel";

export interface CelShadingSettings {
  shadowBands: number;
  bandSoftness: number;
  shadowThreshold: number;
  shadowStrength: number;
  specularStrength: number;
  specularSize: number;
  specularSoftness: number;
  lightColorInfluence: number;
  lightFalloff: "smooth" | "banded";
}

/** Missing scene keys inherit independently, including after project edits. */
export type CelShadingOverrides = Partial<CelShadingSettings>;

export const DEFAULT_CEL_SHADING_SETTINGS: Readonly<CelShadingSettings> = {
  shadowBands: 3,
  bandSoftness: 0.02,
  shadowThreshold: 0.5,
  shadowStrength: 0.65,
  specularStrength: 0.2,
  specularSize: 0.2,
  specularSoftness: 0.02,
  lightColorInfluence: 1,
  lightFalloff: "smooth",
};

export const CEL_SHADING_LIMITS = {
  shadowBands: [2, 8],
  bandSoftness: [0, 0.5],
  shadowThreshold: [0.05, 0.95],
  shadowStrength: [0, 1],
  specularStrength: [0, 1],
  specularSize: [0.01, 1],
  specularSoftness: [0, 0.5],
  lightColorInfluence: [0, 1],
} as const;

/** Invalid override values inherit; finite out-of-range values are clamped. */
export function normalizeCelShadingOverrides(value: unknown): CelShadingOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: CelShadingOverrides = {};
  for (const key of Object.keys(CEL_SHADING_LIMITS) as (keyof typeof CEL_SHADING_LIMITS)[]) {
    const number = source[key];
    if (typeof number !== "number" || !Number.isFinite(number)) continue;
    const [min, max] = CEL_SHADING_LIMITS[key];
    result[key] = Math.min(max, Math.max(min, key === "shadowBands" ? Math.round(number) : number));
  }
  if (source.lightFalloff === "smooth" || source.lightFalloff === "banded") {
    result.lightFalloff = source.lightFalloff;
  }
  return result;
}

export function normalizeCelShadingSettings(value: unknown): CelShadingSettings {
  return { ...DEFAULT_CEL_SHADING_SETTINGS, ...normalizeCelShadingOverrides(value) };
}

export function resolveCelShadingSettings(
  project: unknown,
  overrides?: unknown,
): CelShadingSettings {
  return { ...normalizeCelShadingSettings(project), ...normalizeCelShadingOverrides(overrides) };
}
