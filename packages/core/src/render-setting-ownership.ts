import type { RenderProjectSettings } from "./project";
import type { SceneSettings, ScenePostProcessEntry } from "./scene";
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

/** Scene content owns feature intent; only shadow cost overrides enter scalability. */
export const SCENE_RENDER_SETTING_OWNERS = {
  renderPath: "independent",
  shadowOverrides: "shadows",
  celShading: "independent",
  environmentColor: "independent",
  fogEnabled: "independent",
  fogColor: "independent",
  fogStart: "independent",
  fogEnd: "independent",
  environmentTextureGuid: "independent",
  environmentLighting: "independent",
  mainCameraActorId: "independent",
  mainCameraComponentId: "independent",
  postProcessStack: "independent",
  sceneLayers: "independent",
  cameraBounds2D: "independent",
  gravity: "non-rendering",
  fixedTimestepMs: "non-rendering",
  gameInstanceClass: "non-rendering",
  physicsWorld: "non-rendering",
  grid: "non-rendering",
  editorJoystickEnabled: "non-rendering",
  showNavmesh: "non-rendering",
} as const satisfies Record<
  keyof SceneSettings,
  QualityGroup | "independent" | "non-rendering"
>;
export const POST_PROCESS_ENTRY_SETTING_OWNERS = {
  id: "independent",
  materialGuid: "independent",
  enabled: "independent",
  scalable: "independent",
} as const satisfies Record<keyof ScenePostProcessEntry, "independent">;
