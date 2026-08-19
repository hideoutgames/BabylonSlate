import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RESOLUTION, resolveUiAdtIdeal } from "./index";

describe("resolveUiAdtIdeal", () => {
  it("uses project design space for viewport-layer HUDs", () => {
    expect(
      resolveUiAdtIdeal({
        viewportLayer: true,
        project: {
          designResolution: { width: 1280, height: 720 },
          scaleRule: "fitWidth",
        },
        bitmap: { width: 390, height: 844 },
      }),
    ).toEqual({
      designResolution: { width: 1280, height: 720 },
      scaleRule: "fitWidth",
    });
  });

  it("matches the bitmap 1:1 for widget prefabs", () => {
    expect(
      resolveUiAdtIdeal({
        viewportLayer: false,
        project: {
          designResolution: { width: 1920, height: 1080 },
          scaleRule: "shortestSide",
        },
        bitmap: { width: 400, height: 300 },
      }),
    ).toEqual({
      designResolution: { width: 400, height: 300 },
      scaleRule: "shortestSide",
    });
  });

  it("falls back to the default design resolution when project settings are missing", () => {
    expect(
      resolveUiAdtIdeal({
        viewportLayer: true,
        bitmap: { width: 800, height: 600 },
      }),
    ).toEqual({
      designResolution: { ...DEFAULT_DESIGN_RESOLUTION },
      scaleRule: "shortestSide",
    });
  });
});
