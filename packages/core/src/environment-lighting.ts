/** Scene-selected image based lighting. Independent of clear color and fog. */
export interface EnvironmentLightingSettings {
  enabled: boolean;
  intensity: number;
  /** Rotation about world +Y in degrees, using the scene's handedness. */
  rotationYDegrees: number;
  /** Opt-in diffuse environment contribution to the existing CEL light ramp. */
  celStrength: number;
}

export type EnvironmentLightingOverrides = Partial<EnvironmentLightingSettings>;

export const DEFAULT_ENVIRONMENT_LIGHTING: Readonly<EnvironmentLightingSettings> =
  {
    enabled: true,
    intensity: 1,
    rotationYDegrees: 0,
    celStrength: 0,
  };

export const ENVIRONMENT_LIGHTING_LIMITS = {
  intensity: [0, 64],
  rotationYDegrees: [-180, 180],
  celStrength: [0, 1],
} as const;

/** Invalid fields inherit; disabling preserves every authored dependent field. */
export function normalizeEnvironmentLightingOverrides(
  value: unknown,
): EnvironmentLightingOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: EnvironmentLightingOverrides = {};
  if (typeof source.enabled === "boolean") result.enabled = source.enabled;
  for (const key of Object.keys(
    ENVIRONMENT_LIGHTING_LIMITS,
  ) as (keyof typeof ENVIRONMENT_LIGHTING_LIMITS)[]) {
    const number = source[key];
    if (typeof number !== "number" || !Number.isFinite(number)) continue;
    const [min, max] = ENVIRONMENT_LIGHTING_LIMITS[key];
    result[key] = Math.min(max, Math.max(min, number));
  }
  return result;
}

export function normalizeEnvironmentLightingSettings(
  value: unknown,
): EnvironmentLightingSettings {
  return {
    ...DEFAULT_ENVIRONMENT_LIGHTING,
    ...normalizeEnvironmentLightingOverrides(value),
  };
}

export function resolveEnvironmentLightingSettings(
  project: unknown,
  overrides?: unknown,
): EnvironmentLightingSettings {
  return {
    ...normalizeEnvironmentLightingSettings(project),
    ...normalizeEnvironmentLightingOverrides(overrides),
  };
}
