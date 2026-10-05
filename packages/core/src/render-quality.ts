import {
  normalizeShadowSettings,
  normalizeShadowOverrides,
  SHADOW_PROFILES,
  type ShadowOverrides,
  type ShadowSettings,
} from "./shadows";
import type { RenderProjectSettings } from "./project";

export const QUALITY_LEVELS = ["low", "medium", "high", "ultra"] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];
export type QualityPreset = QualityLevel | "custom";
export type QualityGroup =
  | "shadows"
  | "resolution"
  | "textures"
  | "geometry"
  | "water"
  | "postprocessing"
  | "lighting";
export const QUALITY_GROUPS: readonly QualityGroup[] = [
  "shadows",
  "resolution",
  "textures",
  "geometry",
  "water",
  "postprocessing",
  "lighting",
];
export interface QualitySelection {
  /** Last target tier; preserved independently from a Custom selection. */
  profile?: QualityLevel;
  preset?: QualityPreset;
}
export interface ResolutionQuality extends QualitySelection {
  scale: number;
  dynamic: boolean;
  minScale: number;
  targetFps: number;
}
export interface TextureQuality extends QualitySelection {
  lodBias: number;
  anisotropy: number;
  byteBudget: number;
}
/** Automatic Model LOD selection; generated levels are chosen by screen coverage. */
export interface GeometryQuality extends QualitySelection {
  autoLod: boolean;
  /** Multiplies the distance at which each generated level takes over. */
  lodDistanceScale: number;
}
export const LOD_DISTANCE_SCALE_MIN = 0.25;
export const LOD_DISTANCE_SCALE_MAX = 4;
/** Shader terms compiled into built-in water; one level per project tier. */
export type WaterShadingDetail = "low" | "medium" | "high" | "ultra";
export const WATER_SHADING_DETAILS: readonly WaterShadingDetail[] = ["low", "medium", "high", "ultra"];
/** sky = environment only; screenSpace marches the scene copy; planar mirrors flat bodies. */
export type WaterReflectionMode = "sky" | "screenSpace" | "planar";
export const WATER_REFLECTION_MODES: readonly WaterReflectionMode[] = ["sky", "screenSpace", "planar"];
/**
 * Render-only water cost caps. Physics never reads these: buoyancy and surface
 * queries sample the same analytic waves on every tier and device.
 */
export interface WaterQuality extends QualitySelection {
  /** SLATE_WATER_QUALITY 0..3 (shader terms per tier). */
  shadingDetail: WaterShadingDetail;
  /** Multiplies each body's Surface Resolution; hard vertex caps still apply. */
  meshDensity: number;
  /** Contact-field cells per side (cap). */
  contactResolution: number;
  /** Scene colour + depth copy after opaques (frame-graph path only). */
  refraction: boolean;
  /** Scene copy resolution scale; the copy also feeds screen-space reflections. */
  refractionScale: number;
  reflections: WaterReflectionMode;
  /** Screen-space march steps (compile-time define). */
  reflectionSteps: number;
  /** Planar reflection target scale. */
  planarScale: number;
  /** GPU FFT detail band (render-only). */
  fft: boolean;
  /** FFT grid size per cascade: 64, 128 or 256. */
  fftSize: number;
  fftCascades: number;
}
export const WATER_MESH_DENSITY_MIN = 0.5;
export const WATER_MESH_DENSITY_MAX = 1.5;
export const WATER_CONTACT_RESOLUTION_MIN = 256;
export const WATER_CONTACT_RESOLUTION_MAX = 1024;
/** Bounds shared by refractionScale and planarScale. */
export const WATER_TARGET_SCALE_MIN = 0.25;
export const WATER_TARGET_SCALE_MAX = 1;
export const WATER_REFLECTION_STEPS_MIN = 4;
export const WATER_REFLECTION_STEPS_MAX = 32;
export const WATER_FFT_SIZES = [64, 128, 256] as const;
export const WATER_FFT_CASCADES_MIN = 1;
export const WATER_FFT_CASCADES_MAX = 3;
export type WaterQualityField = Exclude<keyof WaterQuality, keyof QualitySelection>;
// A Record keeps the list complete when WaterQuality gains a field.
const WATER_QUALITY_FIELD_SET: Record<WaterQualityField, true> = {
  shadingDetail: true, meshDensity: true, contactResolution: true, refraction: true, refractionScale: true,
  reflections: true, reflectionSteps: true, planarScale: true, fft: true, fftSize: true, fftCascades: true,
};
/** Every value field, in display order; also the console names for `quality water <field> <value>`. */
export const WATER_QUALITY_FIELDS = Object.keys(WATER_QUALITY_FIELD_SET) as readonly WaterQualityField[];
/** Strict console parsing: out-of-range or non-integer values are rejected, never clamped. */
export function parseWaterQualitySetting(field: string, value: string): Partial<WaterQuality> | undefined {
  const lower = value.toLowerCase();
  const numeric = value.trim() === "" ? NaN : Number(value);
  const within = (min: number, max: number, integer = false) =>
    Number.isFinite(numeric) && numeric >= min && numeric <= max && (!integer || Number.isInteger(numeric));
  switch (field as WaterQualityField) {
    case "shadingDetail": {
      const detail = WATER_SHADING_DETAILS.find((entry) => entry === lower);
      return detail ? { shadingDetail: detail } : undefined;
    }
    case "reflections": {
      const mode = WATER_REFLECTION_MODES.find((entry) => entry.toLowerCase() === lower);
      return mode ? { reflections: mode } : undefined;
    }
    case "refraction":
    case "fft":
      return lower === "on" || lower === "off" ? { [field]: lower === "on" } : undefined;
    case "meshDensity":
      return within(WATER_MESH_DENSITY_MIN, WATER_MESH_DENSITY_MAX) ? { meshDensity: numeric } : undefined;
    case "contactResolution":
      return within(WATER_CONTACT_RESOLUTION_MIN, WATER_CONTACT_RESOLUTION_MAX, true) ? { contactResolution: numeric } : undefined;
    case "refractionScale":
    case "planarScale":
      return within(WATER_TARGET_SCALE_MIN, WATER_TARGET_SCALE_MAX) ? { [field]: numeric } : undefined;
    case "reflectionSteps":
      return within(WATER_REFLECTION_STEPS_MIN, WATER_REFLECTION_STEPS_MAX, true) ? { reflectionSteps: numeric } : undefined;
    case "fftSize":
      return (WATER_FFT_SIZES as readonly number[]).includes(numeric) ? { fftSize: numeric } : undefined;
    case "fftCascades":
      return within(WATER_FFT_CASCADES_MIN, WATER_FFT_CASCADES_MAX, true) ? { fftCascades: numeric } : undefined;
    default:
      return undefined;
  }
}
export interface PostProcessingQuality extends QualitySelection {
  resolutionScale: number;
}
export interface LightingQuality extends QualitySelection {
  localLightMode: "auto" | "manual";
  maxLocalLights: number;
}
export interface RenderingQuality {
  resolution: ResolutionQuality;
  textures: TextureQuality;
  geometry: GeometryQuality;
  water: WaterQuality;
  postprocessing: PostProcessingQuality;
  lighting: LightingQuality;
}
export type QualityOverrides = { shadows?: ShadowOverrides } & {
  [K in keyof RenderingQuality]?: Partial<RenderingQuality[K]>;
};
export type EffectiveRenderingQuality = RenderingQuality & {
  shadows: ShadowSettings;
};
const MIB = 1024 * 1024;
/** Authored targets only; neither these counts nor the labels certify a device. */
export const LOCAL_LIGHT_QUALITY_CAPACITY: Record<QualityLevel, number> = {
  low: 4,
  medium: 16,
  high: 64,
  ultra: 256,
};
export const QUALITY_TARGET_LABELS: Record<QualityLevel, string> = {
  low: "Budget Android Phone",
  medium: "Apple A16",
  high: "Performance Desktop",
  ultra: "High-End Gaming PC",
};
export const RENDER_QUALITY_PROFILES: Record<QualityLevel, RenderingQuality> = {
  low: {
    lighting: { localLightMode: "auto", maxLocalLights: 4 },
    resolution: { scale: 0.75, dynamic: true, minScale: 0.5, targetFps: 60 },
    textures: { lodBias: 1, anisotropy: 2, byteBudget: 256 * MIB },
    geometry: { autoLod: true, lodDistanceScale: 0.5 },
    water: {
      shadingDetail: "low", meshDensity: 0.5, contactResolution: 256,
      refraction: false, refractionScale: 0.5, reflections: "sky", reflectionSteps: 8,
      planarScale: 0.5, fft: false, fftSize: 64, fftCascades: 1,
    },
    postprocessing: { resolutionScale: 0.5 },
  },
  medium: {
    lighting: { localLightMode: "auto", maxLocalLights: 16 },
    resolution: { scale: 1, dynamic: true, minScale: 0.75, targetFps: 60 },
    textures: { lodBias: 0, anisotropy: 4, byteBudget: 512 * MIB },
    geometry: { autoLod: true, lodDistanceScale: 1 },
    water: {
      shadingDetail: "medium", meshDensity: 0.75, contactResolution: 512,
      refraction: true, refractionScale: 0.5, reflections: "sky", reflectionSteps: 8,
      planarScale: 0.5, fft: false, fftSize: 64, fftCascades: 1,
    },
    postprocessing: { resolutionScale: 0.75 },
  },
  high: {
    lighting: { localLightMode: "auto", maxLocalLights: 64 },
    resolution: { scale: 1, dynamic: true, minScale: 0.75, targetFps: 60 },
    textures: { lodBias: 0, anisotropy: 8, byteBudget: 1024 * MIB },
    geometry: { autoLod: true, lodDistanceScale: 1.5 },
    water: {
      shadingDetail: "high", meshDensity: 1, contactResolution: 1024,
      refraction: true, refractionScale: 0.75, reflections: "screenSpace", reflectionSteps: 16,
      planarScale: 0.5, fft: true, fftSize: 128, fftCascades: 2,
    },
    postprocessing: { resolutionScale: 1 },
  },
  ultra: {
    lighting: { localLightMode: "auto", maxLocalLights: 256 },
    resolution: { scale: 1, dynamic: false, minScale: 1, targetFps: 60 },
    textures: { lodBias: 0, anisotropy: 16, byteBudget: 2048 * MIB },
    geometry: { autoLod: true, lodDistanceScale: 2 },
    water: {
      shadingDetail: "ultra", meshDensity: 1.5, contactResolution: 1024,
      refraction: true, refractionScale: 1, reflections: "planar", reflectionSteps: 24,
      planarScale: 0.75, fft: true, fftSize: 256, fftCascades: 3,
    },
    postprocessing: { resolutionScale: 1 },
  },
};
export function isQualityLevel(value: unknown): value is QualityLevel {
  return QUALITY_LEVELS.includes(value as QualityLevel);
}
function selection(source?: QualitySelection): QualitySelection {
  return {
    ...(isQualityLevel(source?.profile) ? { profile: source.profile } : {}),
    ...(source?.preset === "custom" || isQualityLevel(source?.preset)
      ? { preset: source.preset }
      : {}),
  };
}
/** Requested local contribution capacity, independent of the shadow-map budget. */
export function resolveLocalLightBudget(settings: LightingQuality): number {
  const capacity = LOCAL_LIGHT_QUALITY_CAPACITY[settings.profile ?? "medium"];
  return settings.localLightMode === "manual"
    ? Math.max(0, Math.floor(settings.maxLocalLights))
    : capacity;
}
export function normalizeRenderingQuality(value: unknown): RenderingQuality {
  const source =
    value && typeof value === "object"
      ? (value as Partial<RenderingQuality>)
      : {};
  const defaults = RENDER_QUALITY_PROFILES.medium;
  // Projects saved before a group existed follow their other groups' shared tier.
  const legacyGroups = [source.resolution, source.textures, source.postprocessing, source.lighting];
  const geometryTier = source.geometry ? undefined : sharedQualityTier(legacyGroups);
  const geometry: Partial<GeometryQuality> | undefined = source.geometry ??
    (geometryTier ? { ...RENDER_QUALITY_PROFILES[geometryTier].geometry, profile: geometryTier } : undefined);
  const savedWater = isRecord(source.water) ? (source.water as Partial<WaterQuality>) : undefined;
  const waterTier = savedWater
    ? undefined
    : sharedQualityTier(source.geometry ? [...legacyGroups, source.geometry] : legacyGroups);
  const water = savedWater ??
    (waterTier ? { ...RENDER_QUALITY_PROFILES[waterTier].water, profile: waterTier } : undefined);
  const finite = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n)
      ? Math.min(max, Math.max(min, n))
      : fallback;
  const scale = finite(
    source.resolution?.scale,
    defaults.resolution.scale,
    0.25,
    1,
  );
  const normalized: RenderingQuality = {
    resolution: {
      ...selection(source.resolution),
      scale,
      dynamic:
        typeof source.resolution?.dynamic === "boolean"
          ? source.resolution.dynamic
          : defaults.resolution.dynamic,
      minScale: Math.min(
        scale,
        finite(
          source.resolution?.minScale,
          defaults.resolution.minScale,
          0.25,
          1,
        ),
      ),
      targetFps: finite(source.resolution?.targetFps, 60, 1, 240),
    },
    textures: {
      ...selection(source.textures),
      lodBias: Math.round(finite(source.textures?.lodBias, 0, 0, 8)),
      anisotropy: Math.round(finite(source.textures?.anisotropy, 4, 1, 16)),
      byteBudget: finite(
        source.textures?.byteBudget,
        defaults.textures.byteBudget,
        MIB,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    geometry: {
      ...selection(geometry),
      autoLod:
        typeof geometry?.autoLod === "boolean"
          ? geometry.autoLod
          : defaults.geometry.autoLod,
      lodDistanceScale: finite(
        geometry?.lodDistanceScale,
        defaults.geometry.lodDistanceScale,
        LOD_DISTANCE_SCALE_MIN,
        LOD_DISTANCE_SCALE_MAX,
      ),
    },
    water: normalizeWaterQuality(water),
    postprocessing: {
      ...selection(source.postprocessing),
      resolutionScale: finite(
        source.postprocessing?.resolutionScale,
        defaults.postprocessing.resolutionScale,
        0.25,
        1,
      ),
    },
    lighting: {
      ...selection(source.lighting),
      localLightMode:
        source.lighting?.localLightMode === "manual" ? "manual" : "auto",
      maxLocalLights: Math.floor(
        finite(source.lighting?.maxLocalLights, 16, 0, Number.MAX_SAFE_INTEGER),
      ),
    },
  };
  for (const group of [
    "resolution",
    "textures",
    "geometry",
    "water",
    "postprocessing",
    "lighting",
  ] as const) {
    normalized[group].preset = qualityValueLabel(normalized[group], group);
  }
  return normalized;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** The tier every listed group last targeted, or undefined when any differs or is missing. */
function sharedQualityTier(
  groups: readonly (QualitySelection | undefined)[],
): QualityLevel | undefined {
  const first = groups[0]?.profile;
  return isQualityLevel(first) && groups.every((group) => group?.profile === first)
    ? first
    : undefined;
}
function snapWaterFftSize(value: number): number {
  return WATER_FFT_SIZES.reduce((best, size) =>
    Math.abs(Math.log2(size / value)) < Math.abs(Math.log2(best / value)) ? size : best);
}
/**
 * Missing or invalid fields take the saved profile's tier (never plain Medium),
 * so fields added by later releases keep a saved Low/High/Ultra group labelled.
 */
function normalizeWaterQuality(source: Partial<WaterQuality> | undefined): WaterQuality {
  const tier = RENDER_QUALITY_PROFILES[isQualityLevel(source?.profile) ? source.profile : "medium"].water;
  const number = (key: "meshDensity" | "contactResolution" | "refractionScale" | "reflectionSteps" | "planarScale" | "fftSize" | "fftCascades", min: number, max: number) => {
    const value = source?.[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : tier[key];
  };
  const flag = (key: "refraction" | "fft") =>
    typeof source?.[key] === "boolean" ? source[key] : tier[key];
  return {
    ...selection(source),
    shadingDetail: WATER_SHADING_DETAILS.includes(source?.shadingDetail as WaterShadingDetail)
      ? source!.shadingDetail!
      : tier.shadingDetail,
    meshDensity: number("meshDensity", WATER_MESH_DENSITY_MIN, WATER_MESH_DENSITY_MAX),
    contactResolution: Math.round(number("contactResolution", WATER_CONTACT_RESOLUTION_MIN, WATER_CONTACT_RESOLUTION_MAX)),
    refraction: flag("refraction"),
    refractionScale: number("refractionScale", WATER_TARGET_SCALE_MIN, WATER_TARGET_SCALE_MAX),
    reflections: WATER_REFLECTION_MODES.includes(source?.reflections as WaterReflectionMode)
      ? source!.reflections!
      : tier.reflections,
    reflectionSteps: Math.round(number("reflectionSteps", WATER_REFLECTION_STEPS_MIN, WATER_REFLECTION_STEPS_MAX)),
    planarScale: number("planarScale", WATER_TARGET_SCALE_MIN, WATER_TARGET_SCALE_MAX),
    fft: flag("fft"),
    fftSize: snapWaterFftSize(number("fftSize", WATER_FFT_SIZES[0], WATER_FFT_SIZES[WATER_FFT_SIZES.length - 1]!)),
    fftCascades: Math.round(number("fftCascades", WATER_FFT_CASCADES_MIN, WATER_FFT_CASCADES_MAX)),
  };
}
function mergeQualityValues<T extends QualitySelection>(
  base: T,
  patch?: Partial<T>,
): T {
  const values: Partial<T> = patch ?? {};
  const edited = Object.keys(values).some(
    (key) => key !== "preset" && key !== "profile",
  );
  return {
    ...base,
    ...values,
    ...(edited && values.preset === undefined ? { preset: "custom" } : {}),
  };
}
/** Layer overrides without allowing inherited preset metadata to hide manual edits. */
export function mergeRenderingQualityOverrides(
  ...layers: QualityOverrides[]
): QualityOverrides {
  const result: QualityOverrides = {};
  for (const layer of layers)
    for (const group of QUALITY_GROUPS) {
      if (layer[group])
        Object.assign(result, {
          [group]: mergeQualityValues(result[group] ?? {}, layer[group]),
        });
    }
  return result;
}
export function resolveRenderingQuality(
  project: { quality?: RenderingQuality; shadows?: ShadowOverrides } = {},
  scene: ShadowOverrides = {},
  session: QualityOverrides = {},
): EffectiveRenderingQuality {
  const base = normalizeRenderingQuality(project.quality);
  return {
    ...normalizeRenderingQuality({
      resolution: mergeQualityValues(base.resolution, session.resolution),
      textures: mergeQualityValues(base.textures, session.textures),
      geometry: mergeQualityValues(base.geometry, session.geometry),
      water: mergeQualityValues(base.water, session.water),
      postprocessing: mergeQualityValues(
        base.postprocessing,
        session.postprocessing,
      ),
      lighting: mergeQualityValues(base.lighting, session.lighting),
    }),
    shadows: normalizeShadowSettings(
      mergeQualityValues(
        mergeQualityValues(
          normalizeShadowSettings(project.shadows),
          normalizeShadowOverrides(scene),
        ),
        normalizeShadowOverrides(session.shadows),
      ),
    ),
  };
}
export function qualityPresetPatch(
  level: QualityLevel,
  group?: QualityGroup,
): QualityOverrides {
  const profile = RENDER_QUALITY_PROFILES[level];
  const values = {
    resolution: { ...profile.resolution, profile: level, preset: level },
    textures: { ...profile.textures, profile: level, preset: level },
    geometry: { ...profile.geometry, profile: level, preset: level },
    water: { ...profile.water, profile: level, preset: level },
    postprocessing: {
      ...profile.postprocessing,
      profile: level,
      preset: level,
    },
    lighting: { ...profile.lighting, profile: level, preset: level },
    shadows: { ...SHADOW_PROFILES[level], profile: level, preset: level },
  };
  return structuredClone(group ? { [group]: values[group] } : values);
}
export function qualityGroupLabel(
  value: EffectiveRenderingQuality,
  group: QualityGroup,
): QualityLevel | "custom" {
  return qualityValueLabel(value[group], group);
}
function qualityValueLabel(
  value: EffectiveRenderingQuality[QualityGroup],
  group: QualityGroup,
): QualityPreset {
  if (value.preset === "custom") return "custom";
  const preferred = value.preset ?? value.profile;
  const levels = isQualityLevel(preferred)
    ? [preferred, ...QUALITY_LEVELS.filter((level) => level !== preferred)]
    : QUALITY_LEVELS;
  for (const level of levels) {
    // These categories derive Auto capacity and admission from profile, so a
    // mismatched saved label cannot claim a lower tier while requesting more.
    if (
      (group === "lighting" || group === "shadows") &&
      (value.profile ?? "medium") !== level
    )
      continue;
    const preset =
      group === "shadows"
        ? SHADOW_PROFILES[level]
        : RENDER_QUALITY_PROFILES[level][group];
    if (
      Object.entries(preset).every(
        ([key, expected]) =>
          key === "profile" ||
          key === "preset" ||
          (value as unknown as Record<string, unknown>)[key] === expected,
      )
    )
      return level;
  }
  return "custom";
}

/** Explicit manual edits keep Custom provenance even if they match another tier. */
export function qualitySettingPatch<G extends QualityGroup>(
  group: G,
  patch: Partial<EffectiveRenderingQuality[G]>,
): QualityOverrides {
  return { [group]: { ...patch, preset: "custom" } };
}

/** Shared project UI application; artistic and structural properties pass through. */
export function applyProjectQualityPatch(
  settings: RenderProjectSettings,
  patch: QualityOverrides,
): RenderProjectSettings {
  const effective = resolveRenderingQuality(settings, {}, patch);
  const { shadows, ...quality } = effective;
  return { ...settings, shadows, quality };
}

/** Session overrides survive scene changes; creating a new Play session resets them. */
export class RenderingQualitySession {
  overrides: QualityOverrides = {};
  project: { quality?: RenderingQuality; shadows?: ShadowOverrides };
  scene: ShadowOverrides;
  constructor(
    project: { quality?: RenderingQuality; shadows?: ShadowOverrides } = {},
    scene: ShadowOverrides = {},
  ) {
    this.project = project;
    this.scene = scene;
  }
  effective(): EffectiveRenderingQuality {
    return resolveRenderingQuality(this.project, this.scene, this.overrides);
  }
  execute(
    group?: QualityGroup,
    choice?: string,
    value?: string,
  ): { success: boolean; output: string } {
    const previous = this.overrides;
    const result = this.executeRequest(group, choice, value);
    // Render owners use override identity to avoid readiness/resource work.
    if (QUALITY_GROUPS.every((key) => {
      const before = previous[key] as Record<string, unknown> | undefined;
      const after = this.overrides[key] as Record<string, unknown> | undefined;
      const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
      return [...fields].every((field) => before?.[field] === after?.[field]);
    })) this.overrides = previous;
    return result;
  }
  private executeRequest(
    group?: QualityGroup,
    choice?: string,
    value?: string,
  ): { success: boolean; output: string } {
    if (
      value !== undefined &&
      (choice === undefined || choice === "reset" || isQualityLevel(choice))
    )
      return { success: false, output: "Unexpected quality value" };
    if (choice === "reset") {
      this.overrides = { ...this.overrides };
      if (group) delete this.overrides[group];
      else this.overrides = {};
    } else if (isQualityLevel(choice)) {
      const patch = qualityPresetPatch(choice, group);
      this.overrides = {
        ...this.overrides,
        ...patch,
        ...(patch.shadows
          ? { shadows: { ...this.overrides.shadows, ...patch.shadows } }
          : {}),
      };
    } else if (choice !== undefined) {
      const numeric = value === undefined ? NaN : Number(value);
      const water = group === "water" && value !== undefined
        ? parseWaterQualitySetting(choice, value)
        : undefined;
      if (water)
        this.overrides = {
          ...this.overrides,
          water: { ...this.overrides.water, ...water },
        };
      else if (
        group === "lighting" &&
        choice === "budget" &&
        (value === "auto" || (Number.isSafeInteger(numeric) && numeric >= 0))
      )
        this.overrides = {
          ...this.overrides,
          lighting: {
            ...this.overrides.lighting,
            localLightMode: value === "auto" ? "auto" : "manual",
            ...(value === "auto" ? {} : { maxLocalLights: numeric }),
          },
        };
      else if (group === "shadows" && choice === "budget" && value === "auto")
        this.overrides = {
          ...this.overrides,
          shadows: { ...this.overrides.shadows, localLightMode: "auto" },
        };
      else if (
        group === "shadows" &&
        choice === "budget" &&
        Number.isSafeInteger(numeric) &&
        numeric >= 0
      )
        this.overrides = {
          ...this.overrides,
          shadows: {
            ...this.overrides.shadows,
            localLightMode: "manual",
            maxLocalLights: numeric,
          },
        };
      else if (
        group === "shadows" &&
        choice === "distance" &&
        Number.isFinite(numeric) &&
        numeric >= 1 &&
        numeric <= 1_000_000
      )
        this.overrides = {
          ...this.overrides,
          shadows: { ...this.overrides.shadows, distance: numeric },
        };
      else if (
        group === "shadows" &&
        choice === "enabled" &&
        (value === "on" || value === "off")
      )
        this.overrides = {
          ...this.overrides,
          shadows: { ...this.overrides.shadows, enabled: value === "on" },
        };
      else if (
        group === "geometry" &&
        choice === "lod" &&
        (value === "on" || value === "off")
      )
        this.overrides = {
          ...this.overrides,
          geometry: { ...this.overrides.geometry, autoLod: value === "on" },
        };
      else if (
        group === "geometry" &&
        choice === "distance" &&
        Number.isFinite(numeric) &&
        numeric >= LOD_DISTANCE_SCALE_MIN &&
        numeric <= LOD_DISTANCE_SCALE_MAX
      )
        this.overrides = {
          ...this.overrides,
          geometry: { ...this.overrides.geometry, lodDistanceScale: numeric },
        };
      else if (
        group === "resolution" &&
        choice === "scale" &&
        Number.isFinite(numeric) &&
        numeric >= 0.25 &&
        numeric <= 1
      )
        this.overrides = {
          ...this.overrides,
          resolution: {
            ...this.overrides.resolution,
            scale: numeric,
            minScale: numeric,
            dynamic: false,
          },
        };
      else
        return { success: false, output: "Invalid quality setting or value" };
      if (group)
        this.overrides = {
          ...this.overrides,
          ...qualitySettingPatch(group, this.overrides[group] ?? {}),
        };
    }
    const effective = this.effective();
    const groups = group ? [group] : QUALITY_GROUPS;
    return {
      success: true,
      output: groups
        .map(
          (key) =>
            `quality ${key} ${qualityGroupLabel(effective, key)} ${JSON.stringify(effective[key])}`,
        )
        .join("\n"),
    };
  }
}
