/** Authored shadow settings. Device limits never mutate these values. */
export type ShadowProfile = "low" | "medium" | "high" | "ultra";
export interface ShadowSettings {
  enabled: boolean;
  distance: number;
  fadeFraction: number;
  profile: ShadowProfile;
  mapSize: number;
  cascades: number;
  filter: "pcf" | "pcss";
  filterQuality: "low" | "medium" | "high";
  softness: number;
  autoBias: boolean;
  depthBias: number;
  normalBias: number;
  localLightMode: "auto" | "manual";
  maxLocalLights: number;
  localMapSize: number;
}
export type ShadowOverrides = Partial<ShadowSettings>;
export const SHADOW_PROFILES = {
  low: { mapSize: 1024, cascades: 2, filterQuality: "low", localMapSize: 512 },
  medium: {
    mapSize: 2048,
    cascades: 4,
    filterQuality: "high",
    localMapSize: 1024,
  },
  high: {
    mapSize: 2048,
    cascades: 4,
    filterQuality: "high",
    localMapSize: 2048,
  },
  ultra: {
    mapSize: 4096,
    cascades: 4,
    filterQuality: "high",
    localMapSize: 2048,
  },
} as const;
export const DEFAULT_SHADOW_SETTINGS: Readonly<ShadowSettings> = {
  enabled: true,
  distance: 200,
  fadeFraction: 0.1,
  profile: "medium",
  ...SHADOW_PROFILES.medium,
  localLightMode: "auto",
  maxLocalLights: 4,
  filter: "pcf",
  softness: 0.05,
  autoBias: true,
  depthBias: 0.0001,
  normalBias: 0.005,
};
export const SHADOW_LIMITS = {
  distance: [1, 1_000_000],
  fadeFraction: [0, 0.5],
  cascades: [1, 4],
  softness: [0, 1],
  depthBias: [0, 0.05],
  normalBias: [0, 1],
  maxLocalLights: [0, Number.MAX_SAFE_INTEGER],
} as const;
export function normalizeShadowOverrides(value: unknown): ShadowOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: ShadowOverrides = {};
  if (typeof source.enabled === "boolean") result.enabled = source.enabled;
  if (typeof source.autoBias === "boolean") result.autoBias = source.autoBias;
  if (source.localLightMode === "auto" || source.localLightMode === "manual")
    result.localLightMode = source.localLightMode;
  if (
    typeof source.profile === "string" &&
    Object.hasOwn(SHADOW_PROFILES, source.profile)
  )
    result.profile = source.profile as ShadowProfile;
  if (source.filter === "pcf" || source.filter === "pcss")
    result.filter = source.filter;
  if (
    source.filterQuality === "low" ||
    source.filterQuality === "medium" ||
    source.filterQuality === "high"
  )
    result.filterQuality = source.filterQuality;
  for (const key of Object.keys(
    SHADOW_LIMITS,
  ) as (keyof typeof SHADOW_LIMITS)[]) {
    const n = source[key];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const [min, max] = SHADOW_LIMITS[key];
    result[key] = Math.min(
      max,
      Math.max(
        min,
        key === "cascades" || key === "maxLocalLights" ? Math.round(n) : n,
      ),
    );
  }
  for (const key of ["mapSize", "localMapSize"] as const) {
    const n = source[key];
    if (typeof n === "number" && Number.isFinite(n))
      result[key] =
        n <= 256
          ? 256
          : n <= 512
            ? 512
            : n <= 1024
              ? 1024
              : n <= 2048
                ? 2048
                : 4096;
  }
  return result;
}

/** Conservative admission policy; these are not device performance measurements. */
export const SHADOW_CAPACITY_PROFILES = {
  low: { autoLocalLights: 1, byteBudget: 64 * 1024 ** 2, passes: 8 },
  medium: { autoLocalLights: 2, byteBudget: 192 * 1024 ** 2, passes: 16 },
  high: { autoLocalLights: 4, byteBudget: 256 * 1024 ** 2, passes: 28 },
  ultra: { autoLocalLights: 8, byteBudget: 384 * 1024 ** 2, passes: 52 },
} as const;
export function normalizeShadowSettings(value: unknown): ShadowSettings {
  const clean = normalizeShadowOverrides(value);
  // Full legacy project settings wrote four even when no capacity was authored.
  // Keep that ambiguous value as a manual limit instead of inventing intent.
  if (clean.maxLocalLights !== undefined && clean.localLightMode === undefined)
    clean.localLightMode = "manual";
  return {
    ...DEFAULT_SHADOW_SETTINGS,
    ...SHADOW_PROFILES[clean.profile ?? "medium"],
    ...clean,
  };
}
export function resolveShadowSettings(
  project?: ShadowOverrides,
  scene?: ShadowOverrides,
): ShadowSettings {
  return {
    ...normalizeShadowSettings(project),
    ...normalizeShadowOverrides(scene),
  };
}
export function effectiveShadowSettings(
  requested: ShadowSettings,
  supportsCascades = true,
  mode: "pbr" | "cel" = "pbr",
): { settings: ShadowSettings; limits: string[] } {
  const settings = { ...requested };
  const limits: string[] = [];
  if (settings.localLightMode === "auto")
    settings.maxLocalLights =
      SHADOW_CAPACITY_PROFILES[settings.profile].autoLocalLights;
  if (!supportsCascades && settings.cascades > 1) {
    settings.cascades = 1;
    limits.push("cascades: device capability");
  }
  if (mode === "cel" && settings.filter === "pcss") {
    settings.filter = "pcf";
    limits.push("filter: hard CEL shadows");
  }
  return { settings, limits };
}
