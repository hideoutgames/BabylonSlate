/** Authored shadow settings. Device limits never mutate these values. */
export type ShadowProfile = "low" | "medium" | "high" | "ultra";
/**
 * Screen-Space Shadows: the sun's contact shadows marched over the view's depth, from off to high (more steps, a longer
 * march and a farther fade).
 */
export type ScreenShadowsQuality = "off" | "low" | "medium" | "high";
export const SCREEN_SHADOWS_QUALITIES: readonly ScreenShadowsQuality[] = ["off", "low", "medium", "high"];
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
  screenShadows: ScreenShadowsQuality;
  /**
   * Reflection Shadows: each planar reflection that draws (Mirrors, planar water) draws the sun's shadow from cascades
   * fitted to its own view, at the cost of a sun shadow render per drawing reflection. Off, its surfaces take the sun
   * unshadowed; spot and point light shadows show either way.
   */
  reflections: boolean;
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
    reflections: false,
    screenShadows: "off",
    distance: 120,
    mapSize: 2048,
    cascades: 2,
    filterQuality: "low",
    localMapSize: 512,
    maxLocalLights: 1,
  },
  medium: {
    ...SHADOW_PROFILE_COMMON,
    reflections: false,
    screenShadows: "off",
    distance: 250,
    mapSize: 2048,
    cascades: 3,
    filterQuality: "high",
    localMapSize: 1024,
    maxLocalLights: 2,
  },
  high: {
    ...SHADOW_PROFILE_COMMON,
    reflections: false,
    screenShadows: "medium",
    distance: 350,
    mapSize: 2048,
    cascades: 4,
    filterQuality: "high",
    localMapSize: 2048,
    maxLocalLights: 4,
  },
  ultra: {
    ...SHADOW_PROFILE_COMMON,
    reflections: true,
    screenShadows: "high",
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
/**
 * The largest edge each map size setting snaps to (`normalizeShadowOverrides`: powers of two from 256). The sun's 8192
 * is a Custom choice no quality level makes, as its cascades need a 16384 shadow atlas; a point light's six faces
 * could not take 8192 tiles there.
 */
const SHADOW_MAP_SIZE_MAX = { mapSize: 8192, localMapSize: 4096 } as const;
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
  if (typeof source.reflections === "boolean") result.reflections = source.reflections;
  if (source.localLightMode === "auto" || source.localLightMode === "manual")
    result.localLightMode = source.localLightMode;
  if (
    typeof source.profile === "string" &&
    Object.hasOwn(SHADOW_PROFILES, source.profile)
  )
    result.profile = source.profile as ShadowProfile;
  if (source.filter === "pcf" || source.filter === "pcss")
    result.filter = source.filter;
  if (typeof source.screenShadows === "string" && (SCREEN_SHADOWS_QUALITIES as readonly string[]).includes(source.screenShadows))
    result.screenShadows = source.screenShadows as ScreenShadowsQuality;
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
      result[key] = Math.min(SHADOW_MAP_SIZE_MAX[key], 2 ** Math.ceil(Math.log2(Math.max(256, n))));
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

/**
 * Per shadow quality level, the sun's first cascade tile edge as a multiple of the map size: the first cascade holds
 * the shadows nearest the camera, where a texel is largest on screen, so at High its tile has twice the edge (four
 * times the texels) over the same slice. Low and Medium have no atlas room for it, and Ultra's 4096-texel map would
 * need an 8192-texel tile, its whole atlas. A scale is halved while the first tile would be wider than half the atlas's
 * edge (`cascadeTileSizes` in the renderer), so a Custom map size never asks for a tile the atlas cannot hold beside
 * the other cascades: High at 4096 or 8192 keeps the map size there.
 */
export const SHADOW_FIRST_CASCADE_SCALE = { low: 1, medium: 1, high: 2, ultra: 1 } as const satisfies Record<ShadowProfile, number>;

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
  // A capacity given without a mode is a manual limit.
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
  if (mode === "cel" && settings.screenShadows !== "off") {
    settings.screenShadows = "off";
    limits.push("screen shadows: not in CEL");
  }
  return { settings, limits };
}

/** Components drawn unlit (sprites, tilemaps, 3D text): they cast no shadow unless their Cast Shadows is set. */
const UNLIT_CASTER_CLASS_IDS: ReadonlySet<string> = new Set(["SpriteComponent", "TilemapComponent", "Text3DComponent"]);

/** Whether a component of `classId` casts shadows when its Cast Shadows is unset: every visual but an unlit one. */
export function defaultCastShadows(classId: string): boolean {
  return !UNLIT_CASTER_CLASS_IDS.has(classId);
}

/** Whether a component casts shadows: its authored Cast Shadows, or else its class default (`defaultCastShadows`). */
export function componentCastsShadows(classId: string, castShadows: unknown): boolean {
  return typeof castShadows === "boolean" ? castShadows : defaultCastShadows(classId);
}

/**
 * Parts of shadow drawing the `shadowdebug` console command switches off for a Play session, to measure what each
 * costs (the Feature Test Check's Shadows Breakdown): the casters drawn into every map layer (`casters`: each layer is
 * still bound and cleared, and lit surfaces still sample the maps, which hold no caster), and the map passes
 * themselves (`passes`: no layer is bound, cleared or drawn once it has drawn its first, and lit surfaces sample the
 * depth the maps last held).
 */
export const SHADOW_DEBUG_PARTS = ["casters", "passes"] as const;
export type ShadowDebugPart = (typeof SHADOW_DEBUG_PARTS)[number];
