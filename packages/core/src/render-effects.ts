/**
 * Project-wide color pipeline and display-space effect settings. Defaults
 * reproduce the current per-material image processing output exactly: Legacy
 * Display mode, no tone mapping, unit exposure/contrast, every effect off.
 */
export type ColorPipelineMode = "legacyDisplay" | "sceneLinear";
export type RenderEffectsToneMapping = "none" | "standard" | "aces" | "neutral";

export interface ReflectionSettings {
  enabled: boolean;
  /** Ray marching resolution; scene color remains full resolution. */
  resolutionScale: number;
  maxSteps: number;
  maxDistance: number;
  thickness: number;
  strength: number;
}

export interface VolumetricLightingSettings {
  enabled: boolean;
  resolutionScale: number;
  steps: number;
  /** Maximum admitted directional, point and spot contributors per view. */
  maxLights: number;
  density: number;
  intensity: number;
  maxDistance: number;
  anisotropy: number;
}

export interface RenderEffectsSettings {
  /** Stage contract version; Scene Linear renders HDR then resolves display. */
  colorPipeline: { version: 1; mode: ColorPipelineMode };
  toneMapping: RenderEffectsToneMapping;
  exposure: number;
  contrast: number;
  vignette: {
    enabled: boolean;
    weight: number;
    color: [number, number, number];
  };
  bloom: {
    enabled: boolean;
    threshold: number;
    weight: number;
    kernel: number;
    /** Bloom target scale relative to the post-processing resolution. */
    scale: number;
  };
  fxaa: boolean;
  reflections: ReflectionSettings;
  volumetricLighting: VolumetricLightingSettings;
}

export const RENDER_EFFECTS_LIMITS = {
  exposure: [0.01, 100],
  contrast: [0, 10],
  vignetteWeight: [0, 10],
  bloomThreshold: [0, 100],
  bloomWeight: [0, 10],
  bloomKernel: [1, 512],
  bloomScale: [0.05, 1],
  spatialResolutionScale: [0.25, 1],
  reflectionSteps: [8, 128],
  reflectionDistance: [0.1, 1000],
  reflectionThickness: [0.001, 10],
  reflectionStrength: [0, 1],
  volumetricSteps: [8, 64],
  volumetricLights: [1, 4],
  volumetricDensity: [0, 1],
  volumetricIntensity: [0, 10],
  volumetricDistance: [0.1, 1000],
  volumetricAnisotropy: [-0.9, 0.9],
} as const;

export const DEFAULT_RENDER_EFFECTS: Readonly<RenderEffectsSettings> = {
  colorPipeline: { version: 1, mode: "legacyDisplay" },
  toneMapping: "none",
  exposure: 1,
  contrast: 1,
  vignette: { enabled: false, weight: 1.5, color: [0, 0, 0] },
  bloom: { enabled: false, threshold: 0.9, weight: 0.15, kernel: 64, scale: 0.5 },
  fxaa: false,
  reflections: {
    enabled: false, resolutionScale: 0.5, maxSteps: 32,
    maxDistance: 50, thickness: 0.2, strength: 1,
  },
  volumetricLighting: {
    enabled: false, resolutionScale: 0.5, steps: 24, maxLights: 4,
    density: 0.02, intensity: 1, maxDistance: 50, anisotropy: 0.2,
  },
};

const TONE_MAPPINGS: readonly RenderEffectsToneMapping[] = [
  "none",
  "standard",
  "aces",
  "neutral",
];

function finite(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function colorTriple(value: unknown): [number, number, number] {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((index) =>
    finite(source[index], 0, 0, 1),
  ) as [number, number, number];
}

/** Missing and invalid fields inherit the display-identical defaults. */
export function normalizeRenderEffectsSettings(
  value: unknown,
): RenderEffectsSettings {
  const source = object(value);
  const colorPipeline = object(source.colorPipeline);
  const vignette = object(source.vignette);
  const bloom = object(source.bloom);
  const reflections = object(source.reflections);
  const volumetric = object(source.volumetricLighting);
  const reflectionNumber = (key: Exclude<keyof ReflectionSettings, "enabled">, limits: readonly [number, number]) =>
    finite(reflections[key], DEFAULT_RENDER_EFFECTS.reflections[key], ...limits);
  const volumetricNumber = (key: Exclude<keyof VolumetricLightingSettings, "enabled">, limits: readonly [number, number]) =>
    finite(volumetric[key], DEFAULT_RENDER_EFFECTS.volumetricLighting[key], ...limits);
  const color = colorTriple(vignette.color);
  return {
    colorPipeline: {
      version: 1,
      mode:
        colorPipeline.mode === "sceneLinear" ? "sceneLinear" : "legacyDisplay",
    },
    toneMapping: TONE_MAPPINGS.includes(
      source.toneMapping as RenderEffectsToneMapping,
    )
      ? (source.toneMapping as RenderEffectsToneMapping)
      : DEFAULT_RENDER_EFFECTS.toneMapping,
    exposure: finite(
      source.exposure,
      DEFAULT_RENDER_EFFECTS.exposure,
      ...RENDER_EFFECTS_LIMITS.exposure,
    ),
    contrast: finite(
      source.contrast,
      DEFAULT_RENDER_EFFECTS.contrast,
      ...RENDER_EFFECTS_LIMITS.contrast,
    ),
    vignette: {
      enabled: vignette.enabled === true,
      weight: finite(
        vignette.weight,
        DEFAULT_RENDER_EFFECTS.vignette.weight,
        ...RENDER_EFFECTS_LIMITS.vignetteWeight,
      ),
      color,
    },
    bloom: {
      enabled: bloom.enabled === true,
      threshold: finite(
        bloom.threshold,
        DEFAULT_RENDER_EFFECTS.bloom.threshold,
        ...RENDER_EFFECTS_LIMITS.bloomThreshold,
      ),
      weight: finite(
        bloom.weight,
        DEFAULT_RENDER_EFFECTS.bloom.weight,
        ...RENDER_EFFECTS_LIMITS.bloomWeight,
      ),
      kernel: Math.round(
        finite(
          bloom.kernel,
          DEFAULT_RENDER_EFFECTS.bloom.kernel,
          ...RENDER_EFFECTS_LIMITS.bloomKernel,
        ),
      ),
      scale: finite(
        bloom.scale,
        DEFAULT_RENDER_EFFECTS.bloom.scale,
        ...RENDER_EFFECTS_LIMITS.bloomScale,
      ),
    },
    fxaa: source.fxaa === true,
    reflections: {
      enabled: reflections.enabled === true,
      resolutionScale: reflectionNumber("resolutionScale", RENDER_EFFECTS_LIMITS.spatialResolutionScale),
      maxSteps: Math.round(reflectionNumber("maxSteps", RENDER_EFFECTS_LIMITS.reflectionSteps)),
      maxDistance: reflectionNumber("maxDistance", RENDER_EFFECTS_LIMITS.reflectionDistance),
      thickness: reflectionNumber("thickness", RENDER_EFFECTS_LIMITS.reflectionThickness),
      strength: reflectionNumber("strength", RENDER_EFFECTS_LIMITS.reflectionStrength),
    },
    volumetricLighting: {
      enabled: volumetric.enabled === true,
      resolutionScale: volumetricNumber("resolutionScale", RENDER_EFFECTS_LIMITS.spatialResolutionScale),
      steps: Math.round(volumetricNumber("steps", RENDER_EFFECTS_LIMITS.volumetricSteps)),
      maxLights: Math.round(volumetricNumber("maxLights", RENDER_EFFECTS_LIMITS.volumetricLights)),
      density: volumetricNumber("density", RENDER_EFFECTS_LIMITS.volumetricDensity),
      intensity: volumetricNumber("intensity", RENDER_EFFECTS_LIMITS.volumetricIntensity),
      maxDistance: volumetricNumber("maxDistance", RENDER_EFFECTS_LIMITS.volumetricDistance),
      anisotropy: volumetricNumber("anisotropy", RENDER_EFFECTS_LIMITS.volumetricAnisotropy),
    },
  };
}
