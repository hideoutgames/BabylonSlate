import {
  applyProjectQualityPatch,
  createTag,
  normalizeProjectSettings,
  normalizeRenderingQuality,
  qualityPresetPatch,
  type ProjectSettings,
} from "@haptic/core";
import { FEATURE_TEST_ROOT, type FeatureTestContext } from "./context";

/** Tag categories every area may use (`FeatureTest.<Area>`). */
export const FEATURE_TEST_TAGS = [
  "FeatureTest.Physics.Dynamic",
  "FeatureTest.Audio",
  "FeatureTest.AI",
  "FeatureTest.Scripting",
  "FeatureTest.Perf.Heavy",
] as const;

/**
 * Base FeatureTest project settings, then every area's queued patch. The starter is the High showcase and perf workload
 * (its scene-wide Volumetric Lighting needs High), whatever level new projects start at. Dynamic resolution is off so
 * performance runs measure a fixed workload.
 */
export function applyFeatureTestProjectSettings(
  ctx: FeatureTestContext,
  base: ProjectSettings,
): ProjectSettings {
  let tags = base.tags;
  const render = applyProjectQualityPatch(base.render, qualityPresetPatch("high"));
  const quality = normalizeRenderingQuality(render.quality);
  for (const path of FEATURE_TEST_TAGS) tags = createTag(tags, path).registry;
  let settings: ProjectSettings = {
    ...base,
    tags,
    alwaysPackageFolders: [...new Set([...(base.alwaysPackageFolders ?? []), `assets/${FEATURE_TEST_ROOT}`])],
    fonts: { ...base.fonts, defaultFontGuid: ctx.assets.fonts.onest || null },
    render: {
      ...render,
      quality: { ...quality, resolution: { ...quality.resolution, dynamic: false } },
    },
  };
  for (const patch of ctx.settingsPatches) settings = patch(settings);
  return normalizeProjectSettings(settings);
}
