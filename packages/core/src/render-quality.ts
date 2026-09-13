import { normalizeShadowSettings, SHADOW_PROFILES, type ShadowOverrides, type ShadowSettings } from "./shadows";

export const QUALITY_LEVELS = ["low", "medium", "high", "ultra"] as const;
export type QualityLevel = typeof QUALITY_LEVELS[number];
export type QualityGroup = "shadows" | "resolution" | "textures" | "postprocessing";
export const QUALITY_GROUPS: readonly QualityGroup[] = ["shadows", "resolution", "textures", "postprocessing"];
export interface ResolutionQuality { scale: number; dynamic: boolean; minScale: number; targetFps: number }
export interface TextureQuality { lodBias: number; anisotropy: number; byteBudget: number }
export interface PostProcessingQuality { resolutionScale: number }
export interface RenderingQuality {
  resolution: ResolutionQuality;
  textures: TextureQuality;
  postprocessing: PostProcessingQuality;
}
export type QualityOverrides = { shadows?: ShadowOverrides } & { [K in keyof RenderingQuality]?: Partial<RenderingQuality[K]> };
export type EffectiveRenderingQuality = RenderingQuality & { shadows: ShadowSettings };
const MIB = 1024 * 1024;
export const RENDER_QUALITY_PROFILES: Record<QualityLevel, RenderingQuality> = {
  low: { resolution: { scale: 0.75, dynamic: true, minScale: 0.5, targetFps: 60 }, textures: { lodBias: 1, anisotropy: 2, byteBudget: 256 * MIB }, postprocessing: { resolutionScale: 0.5 } },
  medium: { resolution: { scale: 1, dynamic: true, minScale: 0.75, targetFps: 60 }, textures: { lodBias: 0, anisotropy: 4, byteBudget: 512 * MIB }, postprocessing: { resolutionScale: 0.75 } },
  high: { resolution: { scale: 1, dynamic: true, minScale: 0.75, targetFps: 60 }, textures: { lodBias: 0, anisotropy: 8, byteBudget: 1024 * MIB }, postprocessing: { resolutionScale: 1 } },
  ultra: { resolution: { scale: 1, dynamic: false, minScale: 1, targetFps: 60 }, textures: { lodBias: 0, anisotropy: 16, byteBudget: 2048 * MIB }, postprocessing: { resolutionScale: 1 } },
};
export function isQualityLevel(value: unknown): value is QualityLevel {
  return QUALITY_LEVELS.includes(value as QualityLevel);
}
export function normalizeRenderingQuality(value: unknown): RenderingQuality {
  const source = value && typeof value === "object" ? value as Partial<RenderingQuality> : {};
  const defaults = RENDER_QUALITY_PROFILES.medium;
  const finite = (n: unknown, fallback: number, min: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  return {
    resolution: { scale: finite(source.resolution?.scale, defaults.resolution.scale, 0.25, 1), dynamic: source.resolution?.dynamic ?? defaults.resolution.dynamic, minScale: finite(source.resolution?.minScale, defaults.resolution.minScale, 0.25, 1), targetFps: finite(source.resolution?.targetFps, 60, 1, 240) },
    textures: { lodBias: Math.round(finite(source.textures?.lodBias, 0, 0, 8)), anisotropy: Math.round(finite(source.textures?.anisotropy, 4, 1, 16)), byteBudget: finite(source.textures?.byteBudget, defaults.textures.byteBudget, MIB, Number.MAX_SAFE_INTEGER) },
    postprocessing: { resolutionScale: finite(source.postprocessing?.resolutionScale, defaults.postprocessing.resolutionScale, 0.25, 1) },
  };
}
export function resolveRenderingQuality(project: { quality?: RenderingQuality; shadows?: ShadowOverrides } = {}, scene: ShadowOverrides = {}, session: QualityOverrides = {}): EffectiveRenderingQuality {
  const base = normalizeRenderingQuality(project.quality);
  return {
    ...normalizeRenderingQuality({ resolution: { ...base.resolution, ...session.resolution }, textures: { ...base.textures, ...session.textures }, postprocessing: { ...base.postprocessing, ...session.postprocessing } }),
    shadows: normalizeShadowSettings({ ...normalizeShadowSettings(project.shadows), ...scene, ...session.shadows }),
  };
}
export function qualityPresetPatch(level: QualityLevel, group?: QualityGroup): QualityOverrides {
  const values = { ...RENDER_QUALITY_PROFILES[level], shadows: { ...SHADOW_PROFILES[level], profile: level } };
  return structuredClone(group ? { [group]: values[group] } : values);
}
export function qualityGroupLabel(value: EffectiveRenderingQuality, group: QualityGroup): QualityLevel | "custom" {
  for (const level of QUALITY_LEVELS) {
    const preset = qualityPresetPatch(level, group)[group]!;
    if (Object.entries(preset).every(([key, expected]) => key === "profile" || (value[group] as unknown as Record<string, unknown>)[key] === expected)) return level;
  }
  return "custom";
}

/** Session overrides survive scene changes; creating a new Play session resets them. */
export class RenderingQualitySession {
  overrides: QualityOverrides = {};
  project: { quality?: RenderingQuality; shadows?: ShadowOverrides };
  scene: ShadowOverrides;
  constructor(project: { quality?: RenderingQuality; shadows?: ShadowOverrides } = {}, scene: ShadowOverrides = {}) { this.project = project; this.scene = scene; }
  effective(): EffectiveRenderingQuality { return resolveRenderingQuality(this.project, this.scene, this.overrides); }
  execute(group?: QualityGroup, choice?: string, value?: string): { success: boolean; output: string } {
    if (choice === "reset") {
      if (group) delete this.overrides[group]; else this.overrides = {};
    } else if (isQualityLevel(choice)) {
      const patch = qualityPresetPatch(choice, group);
      this.overrides = { ...this.overrides, ...patch,
        ...(patch.shadows ? { shadows: { ...this.overrides.shadows, ...patch.shadows } } : {}),
      };
    } else if (choice !== undefined) {
      const numeric = value === undefined ? NaN : Number(value);
      if (group === "shadows" && choice === "budget" && Number.isSafeInteger(numeric) && numeric >= 0)
        this.overrides.shadows = { ...this.overrides.shadows, maxLocalLights: numeric };
      else if (group === "shadows" && choice === "distance" && Number.isFinite(numeric) && numeric >= 1 && numeric <= 1_000_000)
        this.overrides.shadows = { ...this.overrides.shadows, distance: numeric };
      else if (group === "shadows" && choice === "enabled" && (value === "on" || value === "off"))
        this.overrides.shadows = { ...this.overrides.shadows, enabled: value === "on" };
      else if (group === "resolution" && choice === "scale" && Number.isFinite(numeric) && numeric >= 0.25 && numeric <= 1)
        this.overrides.resolution = { ...this.overrides.resolution, scale: numeric, minScale: numeric, dynamic: false };
      else return { success: false, output: "Invalid quality setting or value" };
    }
    const effective = this.effective();
    const groups = group ? [group] : QUALITY_GROUPS;
    return { success: true, output: groups.map((key) => `quality ${key} ${qualityGroupLabel(effective, key)} ${JSON.stringify(effective[key])}`).join("\n") };
  }
}
