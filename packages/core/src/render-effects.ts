/**
 * Project-wide color pipeline and display-space effect settings. Defaults
 * reproduce the current per-material image processing output exactly: Legacy
 * Display mode, no tone mapping, unit exposure/contrast, every effect off.
 */
export type ColorPipelineMode = "legacyDisplay" | "sceneLinear";
export type RenderEffectsToneMapping = "none" | "standard" | "aces" | "neutral";

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
}

export const RENDER_EFFECTS_LIMITS = {
  exposure: [0.01, 100],
  contrast: [0, 10],
  vignetteWeight: [0, 10],
  bloomThreshold: [0, 100],
  bloomWeight: [0, 10],
  bloomKernel: [1, 512],
  bloomScale: [0.05, 1],
} as const;

export const DEFAULT_RENDER_EFFECTS: Readonly<RenderEffectsSettings> = {
  colorPipeline: { version: 1, mode: "legacyDisplay" },
  toneMapping: "none",
  exposure: 1,
  contrast: 1,
  vignette: { enabled: false, weight: 1.5, color: [0, 0, 0] },
  bloom: { enabled: false, threshold: 0.9, weight: 0.15, kernel: 64, scale: 0.5 },
  fxaa: false,
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
  };
}
