/** Authored shadow settings. Device limits never mutate these values. */
export type ShadowProfile = "economy" | "a16" | "high" | "ultra";
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
  maxLocalLights: number;
  localMapSize: number;
}
export type ShadowOverrides = Partial<ShadowSettings>;
export const SHADOW_PROFILES = {
  economy: { mapSize: 1024, cascades: 1, filterQuality: "low", maxLocalLights: 0, localMapSize: 256 },
  a16: { mapSize: 1024, cascades: 2, filterQuality: "medium", maxLocalLights: 1, localMapSize: 512 },
  high: { mapSize: 2048, cascades: 3, filterQuality: "medium", maxLocalLights: 2, localMapSize: 1024 },
  ultra: { mapSize: 2048, cascades: 4, filterQuality: "high", maxLocalLights: 4, localMapSize: 1024 },
} as const;
export const DEFAULT_SHADOW_SETTINGS: Readonly<ShadowSettings> = {
  enabled: true, distance: 200, fadeFraction: 0.1, profile: "a16",
  ...SHADOW_PROFILES.a16,
  filter: "pcf", softness: 0.05, autoBias: true, depthBias: 0.0001, normalBias: 0.005,
};
export const SHADOW_LIMITS = {
  distance: [1, 1_000_000], fadeFraction: [0, 0.5], cascades: [1, 4],
  softness: [0, 1], depthBias: [0, 0.05], normalBias: [0, 1], maxLocalLights: [0, 4],
} as const;
export function normalizeShadowOverrides(value: unknown): ShadowOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: ShadowOverrides = {};
  if (typeof source.enabled === "boolean") result.enabled = source.enabled;
  if (typeof source.autoBias === "boolean") result.autoBias = source.autoBias;
  if (typeof source.profile === "string" && Object.hasOwn(SHADOW_PROFILES, source.profile))
    result.profile = source.profile as ShadowProfile;
  if (source.filter === "pcf" || source.filter === "pcss") result.filter = source.filter;
  if (source.filterQuality === "low" || source.filterQuality === "medium" || source.filterQuality === "high")
    result.filterQuality = source.filterQuality;
  for (const key of Object.keys(SHADOW_LIMITS) as (keyof typeof SHADOW_LIMITS)[]) {
    const n = source[key];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const [min, max] = SHADOW_LIMITS[key];
    result[key] = Math.min(max, Math.max(min, key === "cascades" || key === "maxLocalLights" ? Math.round(n) : n));
  }
  for (const key of ["mapSize", "localMapSize"] as const) {
    const n = source[key];
    if (typeof n === "number" && Number.isFinite(n))
      result[key] = n <= 256 ? 256 : n <= 512 ? 512 : n <= 1024 ? 1024 : 2048;
  }
  return result;
}
export function normalizeShadowSettings(value: unknown): ShadowSettings {
  const clean = normalizeShadowOverrides(value);
  return { ...DEFAULT_SHADOW_SETTINGS, ...SHADOW_PROFILES[clean.profile ?? "a16"], ...clean };
}
export function resolveShadowSettings(project?: ShadowOverrides, scene?: ShadowOverrides): ShadowSettings {
  return { ...normalizeShadowSettings(project), ...normalizeShadowOverrides(scene) };
}
export type ShadowDeviceProfile = ShadowProfile | "project";
export function effectiveShadowSettings(
  requested: ShadowSettings, device: ShadowDeviceProfile = "project", supportsCascades = true,
  mode: "pbr" | "cel" = "pbr",
): { settings: ShadowSettings; limits: string[] } {
  const settings = { ...requested };
  const limits: string[] = [];
  if (device !== "project") {
    const cap = SHADOW_PROFILES[device];
    for (const key of ["mapSize", "cascades", "maxLocalLights", "localMapSize"] as const) {
      if (settings[key] > cap[key]) { settings[key] = cap[key]; limits.push(`${key}: device profile`); }
    }
    const tiers = ["low", "medium", "high"] as const;
    if (tiers.indexOf(settings.filterQuality) > tiers.indexOf(cap.filterQuality)) {
      settings.filterQuality = cap.filterQuality; limits.push("filterQuality: device profile");
    }
    if ((device === "economy" || device === "a16") && settings.filter === "pcss") {
      settings.filter = "pcf"; limits.push("filter: device profile");
    }
  }
  if (!supportsCascades && settings.cascades > 1) {
    settings.cascades = 1; limits.push("cascades: device capability");
  }
  if (mode === "cel" && settings.filter === "pcss") {
    settings.filter = "pcf"; limits.push("filter: hard CEL shadows");
  }
  return { settings, limits };
}
