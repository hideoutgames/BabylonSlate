import type { RenderProjectSettings } from "./project";
import type { EffectiveRenderingQuality, QualityGroup } from "./render-quality";

/** Every renderer cost field has one owner; provenance and safety-tier metadata are not controls. */
export const SCALABILITY_FIELD_OWNERS = {
  shadows: {
    enabled: "shadows",
    distance: "shadows",
    fadeFraction: "shadows",
    mapSize: "shadows",
    cascades: "shadows",
    filter: "shadows",
    filterQuality: "shadows",
    softness: "shadows",
    autoBias: "shadows",
    depthBias: "shadows",
    normalBias: "shadows",
    localLightMode: "shadows",
    maxLocalLights: "shadows",
    localMapSize: "shadows",
  },
  resolution: {
    scale: "resolution",
    dynamic: "resolution",
    minScale: "resolution",
    targetFps: "resolution",
  },
  textures: {
    lodBias: "textures",
    anisotropy: "textures",
    byteBudget: "textures",
  },
  postprocessing: { resolutionScale: "postprocessing" },
  lighting: { localLightMode: "lighting", maxLocalLights: "lighting" },
} as const satisfies {
  [G in QualityGroup]: Record<
    Exclude<keyof EffectiveRenderingQuality[G], "profile" | "preset">,
    G
  >;
};

/** Artistic intent and structural Engine/output choices are independent of scalability. */
export const PROJECT_RENDER_SETTING_OWNERS = {
  quality: "scalability",
  shadows: "shadows",
  renderPath: "independent",
  gpuBackend: "independent",
  mode: "independent",
  cel: "independent",
  environmentLighting: "independent",
  customResolution: "independent",
  width: "independent",
  height: "independent",
  blackBars: "independent",
} as const satisfies Record<
  keyof RenderProjectSettings,
  QualityGroup | "scalability" | "independent"
>;
