import type { ScaleRule } from "./types";
import { DEFAULT_DESIGN_RESOLUTION } from "./types";

export interface UiAdtIdeal {
  designResolution: { width: number; height: number };
  scaleRule: ScaleRule;
}

/**
 * Viewport-layer HUDs share one Play ADT ideal (project design space).
 * Widget prefabs author 1:1 with the bitmap (no adaptive scale).
 */
export function resolveUiAdtIdeal(options: {
  viewportLayer: boolean;
  project?: Partial<UiAdtIdeal> | null;
  bitmap: { width: number; height: number };
}): UiAdtIdeal {
  if (!options.viewportLayer) {
    return {
      designResolution: {
        width: Math.max(1, options.bitmap.width),
        height: Math.max(1, options.bitmap.height),
      },
      scaleRule: "shortestSide",
    };
  }
  const width = options.project?.designResolution?.width;
  const height = options.project?.designResolution?.height;
  const scaleRule = options.project?.scaleRule;
  return {
    designResolution: {
      width:
        typeof width === "number" && width > 0
          ? width
          : DEFAULT_DESIGN_RESOLUTION.width,
      height:
        typeof height === "number" && height > 0
          ? height
          : DEFAULT_DESIGN_RESOLUTION.height,
    },
    scaleRule:
      scaleRule === "fitWidth" || scaleRule === "fitHeight"
        ? scaleRule
        : "shortestSide",
  };
}
