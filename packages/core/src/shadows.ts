/** Authored shadow settings. Device limits never mutate these values. */
export type ShadowProfile = "low" | "medium" | "high" | "ultra";
export interface ShadowSettings {
  /** UI provenance; profile remains the admission tier when this is Custom. */
  preset?: ShadowProfile | "custom";
  enabled: boolean;
  distance: number;
  fadeFraction: number;
  profile: ShadowProfile;
  mapSize: number;
  cascades: number;
  filter: "pcf" | "pcss";
  filterQuality: "low" | "medium" | "high";
  softness: number;
  /** Adapt directional maps/cascades. Point and spot lights use authored offsets. */
  autoBias: boolean;
  /** Native Babylon bias units; a floor in directional automatic mode. */
  depthBias: number;
  /** World-space normal inset, retained exactly in both automatic and manual modes. */
  normalBias: number;
  localLightMode: "auto" | "manual";
  maxLocalLights: number;
  localMapSize: number;
}
export type ShadowOverrides = Partial<ShadowSettings>;
const SHADOW_PROFILE_COMMON = {
  enabled: true,
  fadeFraction: 0.1,
  filter: "pcf",
  softness: 0.05,
  autoBias: true,
  depthBias: 0.0001,
  normalBias: 0.005,
  localLightMode: "auto",
} as const;
export const SHADOW_PROFILES = {
  low: {
    ...SHADOW_PROFILE_COMMON,
    distance: 120,
    mapSize: 2048,
    cascades: 2,
    filterQuality: "low",
    localMapSize: 512,
    maxLocalLights: 1,
  },
  medium: {
    ...SHADOW_PROFILE_COMMON,
    distance: 250,
    mapSize: 2048,
    cascades: 3,
    filterQuality: "high",
    localMapSize: 1024,
    maxLocalLights: 2,
  },
  high: {
    ...SHADOW_PROFILE_COMMON,
    distance: 350,
    mapSize: 2048,
    cascades: 4,
    filterQuality: "high",
    localMapSize: 2048,
    maxLocalLights: 4,
  },
  ultra: {
    ...SHADOW_PROFILE_COMMON,
    distance: 600,
    mapSize: 4096,
    cascades: 4,
    filterQuality: "high",
    localMapSize: 2048,
    maxLocalLights: 8,
  },
} as const satisfies Record<
  ShadowProfile,
  Omit<ShadowSettings, "profile" | "preset">
>;
/**
 * Values earlier releases gave a level. Saved settings still labelled with that level and holding exactly these were
 * never edited, so they load as the level's current values instead of turning Custom.
 */
const SUPERSEDED_SHADOW_PROFILES: Partial<Record<ShadowProfile, Omit<ShadowSettings, "profile" | "preset">>> = {
  low: { ...SHADOW_PROFILE_COMMON, distance: 80, mapSize: 1024, cascades: 1, filterQuality: "low", localMapSize: 512, maxLocalLights: 1 },
  medium: { ...SHADOW_PROFILE_COMMON, distance: 200, mapSize: 2048, cascades: 2, filterQuality: "medium", localMapSize: 1024, maxLocalLights: 2 },
};
export const DEFAULT_SHADOW_SETTINGS: Readonly<ShadowSettings> = {
  profile: "medium",
  ...SHADOW_PROFILES.medium,
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
  if (
    source.preset === "custom" ||
    (typeof source.preset === "string" &&
      Object.hasOwn(SHADOW_PROFILES, source.preset))
  )
    result.preset = source.preset as ShadowSettings["preset"];
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

/**
 * Per shadow quality level, the smallest caster a sun cascade after the first draws: its bounding sphere's diameter in
 * that cascade's texels. A smaller one's shadow is too small to resolve there; the first cascade draws every caster.
 */
/**
 * Per shadow quality level, how many of the sun's last cascades get a tile of half the map size's edge: far cascades
 * cover more ground per texel anyway, and their shadows are seen small. The first cascade always keeps the full size.
 */
export const SHADOW_HALF_TILE_CASCADES = { low: 0, medium: 1, high: 1, ultra: 2 } as const satisfies Record<ShadowProfile, number>;

export const SHADOW_FAR_CASTER_MIN_TEXELS = { low: 3, medium: 2, high: 1.5, ultra: 1 } as const satisfies Record<ShadowProfile, number>;

/** Conservative admission policy; these are not device performance measurements. */
export const SHADOW_CAPACITY_PROFILES = {
  low: { autoLocalLights: 1, byteBudget: 64 * 1024 ** 2, passes: 8 },
  medium: { autoLocalLights: 2, byteBudget: 192 * 1024 ** 2, passes: 16 },
  high: { autoLocalLights: 4, byteBudget: 256 * 1024 ** 2, passes: 28 },
  ultra: { autoLocalLights: 8, byteBudget: 768 * 1024 ** 2, passes: 52 },
} as const;
export function normalizeShadowSettings(value: unknown): ShadowSettings {
  const clean = normalizeShadowOverrides(value);
  // Full legacy project settings wrote four even when no capacity was authored.
  // Keep that ambiguous value as a manual limit instead of inventing intent.
  if (clean.maxLocalLights !== undefined && clean.localLightMode === undefined)
    clean.localLightMode = "manual";
  const settings: ShadowSettings = {
    ...DEFAULT_SHADOW_SETTINGS,
    ...SHADOW_PROFILES[clean.profile ?? "medium"],
    ...clean,
  };
  const preferred =
    clean.preset !== "custom" ? (clean.preset ?? settings.profile) : undefined;
  const levels = [preferred, ...Object.keys(SHADOW_PROFILES)] as (
    ShadowProfile | undefined
  )[];
  settings.preset =
    clean.preset === "custom"
      ? "custom"
      : (levels.find(
          (level) =>
            level &&
            level === settings.profile &&
            Object.entries(SHADOW_PROFILES[level]).every(
              ([key, expected]) =>
                settings[key as keyof ShadowSettings] === expected,
            ),
        ) ?? "custom");
  const saved = clean.preset;
  const superseded = saved && saved !== "custom" && saved === settings.profile ? SUPERSEDED_SHADOW_PROFILES[saved] : undefined;
  if (settings.preset === "custom" && superseded &&
    Object.entries(superseded).every(([key, expected]) => settings[key as keyof ShadowSettings] === expected))
    return { ...settings, ...SHADOW_PROFILES[saved as ShadowProfile], preset: saved };
  return settings;
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
/** The largest shadow map edges a device class allocates, whatever the quality level asks for. */
export interface ShadowMapSizeCap {
  mapSize: number;
  localMapSize: number;
}
export function effectiveShadowSettings(
  requested: ShadowSettings,
  supportsCascades = true,
  mode: "pbr" | "cel" = "pbr",
  mapSizeCap: ShadowMapSizeCap | null = null,
): { settings: ShadowSettings; limits: string[] } {
  const settings = { ...requested };
  const limits: string[] = [];
  if (mapSizeCap && (settings.mapSize > mapSizeCap.mapSize || settings.localMapSize > mapSizeCap.localMapSize)) {
    settings.mapSize = Math.min(settings.mapSize, mapSizeCap.mapSize);
    settings.localMapSize = Math.min(settings.localMapSize, mapSizeCap.localMapSize);
    limits.push(`shadow maps: at most ${mapSizeCap.mapSize} directional, ${mapSizeCap.localMapSize} local on this device class`);
  }
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
