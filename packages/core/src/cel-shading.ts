import { DEFAULT_OUTLINE_PROPERTIES, normalizeOutlineColor, OUTLINE_WIDTH_LIMITS } from "./outline-component";

/** Native surface lighting; PBR is the default project mode. */
export type RenderMode = "pbr" | "cel";

export interface CelShadingSettings {
  shadowBands: number;
  shadowThreshold: number;
  shadowStrength: number;
  specularEnabled: boolean;
  specularStrength: number;
  specularSize: number;
  lightColorInfluence: number;
  lightMixing: "strongest" | "additive" | "blend";
  outlinesEnabled: boolean;
  outlineColor: [number, number, number];
  /** Strictly occluded global outlines, measured in output pixels. */
  outlineWidth: number;
  /** Shrink global CEL outlines between the two camera distances in scene units. */
  outlineDistanceFadeEnabled: boolean;
  outlineFadeStart: number;
  outlineFadeEnd: number;
}

/** Missing scene keys inherit independently, including after project edits. */
export type CelShadingOverrides = Partial<CelShadingSettings>;

export const DEFAULT_CEL_SHADING_SETTINGS: Readonly<CelShadingSettings> = {
  shadowBands: 3,
  shadowThreshold: 0.5,
  shadowStrength: 0.65,
  specularEnabled: true,
  specularStrength: 0.2,
  specularSize: 0.2,
  lightColorInfluence: 1,
  lightMixing: "strongest",
  outlinesEnabled: true,
  outlineColor: [...DEFAULT_OUTLINE_PROPERTIES.color],
  outlineWidth: DEFAULT_OUTLINE_PROPERTIES.width,
  outlineDistanceFadeEnabled: false,
  outlineFadeStart: 50,
  outlineFadeEnd: 100,
};

export const CEL_SHADING_LIMITS = {
  shadowBands: [2, 8],
  shadowThreshold: [0.05, 0.95],
  shadowStrength: [0, 1],
  specularStrength: [0, 1],
  specularSize: [0.01, 1],
  lightColorInfluence: [0, 1],
  outlineWidth: OUTLINE_WIDTH_LIMITS,
  outlineFadeStart: [0, 999_999.99],
  outlineFadeEnd: [0.01, 1_000_000],
} as const;

/** Invalid override values inherit; finite out-of-range values are clamped. */
export function normalizeCelShadingOverrides(
  value: unknown,
): CelShadingOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: CelShadingOverrides = {};
  if (typeof source.outlinesEnabled === "boolean")
    result.outlinesEnabled = source.outlinesEnabled;
  if (typeof source.outlineDistanceFadeEnabled === "boolean")
    result.outlineDistanceFadeEnabled = source.outlineDistanceFadeEnabled;
  const outlineColor = normalizeOutlineColor(source.outlineColor);
  if (outlineColor) result.outlineColor = outlineColor;
  if (typeof source.specularEnabled === "boolean")
    result.specularEnabled = source.specularEnabled;
  for (const key of Object.keys(
    CEL_SHADING_LIMITS,
  ) as (keyof typeof CEL_SHADING_LIMITS)[]) {
    const number = source[key];
    if (typeof number !== "number" || !Number.isFinite(number)) continue;
    const [min, max] = CEL_SHADING_LIMITS[key];
    result[key] = Math.min(
      max,
      Math.max(min, key === "shadowBands" ? Math.round(number) : number),
    );
  }
  if (
    source.lightMixing === "strongest" ||
    source.lightMixing === "additive" ||
    source.lightMixing === "blend"
  )
    result.lightMixing = source.lightMixing;
  return result;
}

export function normalizeCelShadingSettings(
  value: unknown,
): CelShadingSettings {
  return resolveOutlineFadeRange({
    ...DEFAULT_CEL_SHADING_SETTINGS,
    outlineColor: [...DEFAULT_CEL_SHADING_SETTINGS.outlineColor],
    ...normalizeCelShadingOverrides(value),
  });
}

export function resolveCelShadingSettings(
  project: unknown,
  overrides?: unknown,
): CelShadingSettings {
  return resolveOutlineFadeRange({
    ...normalizeCelShadingSettings(project),
    ...normalizeCelShadingOverrides(overrides),
  });
}

/** Validate the pair after inheritance without inventing sparse override keys. */
function resolveOutlineFadeRange(settings: CelShadingSettings): CelShadingSettings {
  settings.outlineFadeEnd = Math.max(settings.outlineFadeEnd, settings.outlineFadeStart + 0.01);
  return settings;
}
