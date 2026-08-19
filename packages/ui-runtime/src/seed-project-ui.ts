import type { ScaleRule } from "./types";
import { DEFAULT_DESIGN_RESOLUTION } from "./types";
import type { UiAdtIdeal } from "./adt-ideal";

export type UiSeedDocument = {
  viewportLayer?: boolean;
  designResolution?: { width: number; height: number };
  scaleRule?: string;
};

function asScaleRule(value: unknown): ScaleRule {
  return value === "fitWidth" || value === "fitHeight" ? value : "shortestSide";
}

/**
 * When project.json omitted `settings.ui`, copy the first viewport-layer
 * document's design space. Prefabs (`viewportLayer: false`) are skipped.
 */
export function seedUiProjectSettings(
  current: UiAdtIdeal,
  omitted: boolean,
  documents: readonly UiSeedDocument[],
): UiAdtIdeal {
  if (!omitted) return current;
  for (const document of documents) {
    if (document.viewportLayer === false) continue;
    const width = document.designResolution?.width;
    const height = document.designResolution?.height;
    if (
      typeof width === "number" &&
      width > 0 &&
      typeof height === "number" &&
      height > 0
    ) {
      return {
        designResolution: { width, height },
        scaleRule: asScaleRule(document.scaleRule),
      };
    }
  }
  return {
    designResolution: { ...DEFAULT_DESIGN_RESOLUTION },
    scaleRule: current.scaleRule ?? "shortestSide",
  };
}

export function projectUiSettingsOmitted(settings: unknown): boolean {
  return !(
    settings &&
    typeof settings === "object" &&
    "ui" in (settings as Record<string, unknown>)
  );
}
