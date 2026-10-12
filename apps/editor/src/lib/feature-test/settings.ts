import {
  createTag,
  normalizeProjectSettings,
  normalizeRenderingQuality,
  type ProjectSettings,
} from "@babylonslate/core";
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
 * Base FeatureTest project settings, then every area's queued patch. Dynamic
 * resolution is off so performance runs measure a fixed workload.
 */
export function applyFeatureTestProjectSettings(
  ctx: FeatureTestContext,
  base: ProjectSettings,
): ProjectSettings {
  let tags = base.tags;
  const quality = normalizeRenderingQuality(base.render.quality);
  for (const path of FEATURE_TEST_TAGS) tags = createTag(tags, path).registry;
  let settings: ProjectSettings = {
    ...base,
    tags,
    alwaysPackageFolders: [...new Set([...(base.alwaysPackageFolders ?? []), `assets/${FEATURE_TEST_ROOT}`])],
    fonts: { ...base.fonts, defaultFontGuid: ctx.assets.fonts.geist || null },
    render: {
      ...base.render,
      quality: { ...quality, resolution: { ...quality.resolution, dynamic: false } },
    },
  };
  for (const patch of ctx.settingsPatches) settings = patch(settings);
  return normalizeProjectSettings(settings);
}
