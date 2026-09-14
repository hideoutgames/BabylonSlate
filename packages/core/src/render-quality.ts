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
  "shadows" | "resolution" | "textures" | "postprocessing" | "lighting";
export const QUALITY_GROUPS: readonly QualityGroup[] = [
  "shadows",
  "resolution",
  "textures",
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
    postprocessing: { resolutionScale: 0.5 },
  },
  medium: {
    lighting: { localLightMode: "auto", maxLocalLights: 16 },
    resolution: { scale: 1, dynamic: true, minScale: 0.75, targetFps: 60 },
    textures: { lodBias: 0, anisotropy: 4, byteBudget: 512 * MIB },
    postprocessing: { resolutionScale: 0.75 },
  },
  high: {
    lighting: { localLightMode: "auto", maxLocalLights: 64 },
    resolution: { scale: 1, dynamic: true, minScale: 0.75, targetFps: 60 },
    textures: { lodBias: 0, anisotropy: 8, byteBudget: 1024 * MIB },
    postprocessing: { resolutionScale: 1 },
  },
  ultra: {
    lighting: { localLightMode: "auto", maxLocalLights: 256 },
    resolution: { scale: 1, dynamic: false, minScale: 1, targetFps: 60 },
    textures: { lodBias: 0, anisotropy: 16, byteBudget: 2048 * MIB },
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
    ? Math.min(capacity, Math.max(0, Math.floor(settings.maxLocalLights)))
    : capacity;
}
export function normalizeRenderingQuality(value: unknown): RenderingQuality {
  const source =
    value && typeof value === "object"
      ? (value as Partial<RenderingQuality>)
      : {};
  const defaults = RENDER_QUALITY_PROFILES.medium;
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
    "postprocessing",
    "lighting",
  ] as const) {
    normalized[group].preset = qualityValueLabel(normalized[group], group);
  }
  return normalized;
}
function mergeQualityValues<T extends QualitySelection>(
  base: T,
  patch?: Partial<T>,
): T {
  const values = patch ?? {};
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
      if (
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
