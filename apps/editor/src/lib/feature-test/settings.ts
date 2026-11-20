import {
  createTag,
  normalizeProjectSettings,
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

/** Base FeatureTest project settings, then every area's queued patch. */
export function applyFeatureTestProjectSettings(
  ctx: FeatureTestContext,
  base: ProjectSettings,
): ProjectSettings {
  let tags = base.tags;
  for (const path of FEATURE_TEST_TAGS) tags = createTag(tags, path).registry;
  let settings: ProjectSettings = {
    ...base,
    tags,
    alwaysPackageFolders: [...new Set([...(base.alwaysPackageFolders ?? []), `assets/${FEATURE_TEST_ROOT}`])],
    fonts: { ...base.fonts, defaultFontGuid: ctx.assets.fonts.onest || null },
  };
  for (const patch of ctx.settingsPatches) settings = patch(settings);
  return normalizeProjectSettings(settings);
}
