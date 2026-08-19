import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RESOLUTION } from "./types";
import {
  projectUiSettingsOmitted,
  seedUiProjectSettings,
} from "./seed-project-ui";

const defaults = {
  designResolution: { ...DEFAULT_DESIGN_RESOLUTION },
  scaleRule: "shortestSide" as const,
};

describe("projectUiSettingsOmitted", () => {
  it("is true when settings.ui is missing", () => {
    expect(projectUiSettingsOmitted(undefined)).toBe(true);
    expect(projectUiSettingsOmitted({})).toBe(true);
    expect(projectUiSettingsOmitted({ fonts: {} })).toBe(true);
  });

  it("is false when settings.ui is present even if empty", () => {
    expect(projectUiSettingsOmitted({ ui: {} })).toBe(false);
    expect(
      projectUiSettingsOmitted({
        ui: { designResolution: { width: 1280, height: 720 } },
      }),
    ).toBe(false);
  });
});

describe("seedUiProjectSettings", () => {
  it("keeps the current settings when project.json already had ui", () => {
    expect(
      seedUiProjectSettings(
        {
          designResolution: { width: 1920, height: 1080 },
          scaleRule: "shortestSide",
        },
        false,
        [
          {
            viewportLayer: true,
            designResolution: { width: 1280, height: 720 },
            scaleRule: "fitWidth",
          },
        ],
      ),
    ).toEqual({
      designResolution: { width: 1920, height: 1080 },
      scaleRule: "shortestSide",
    });
  });

  it("copies the first viewport-layer document when ui was omitted", () => {
    expect(
      seedUiProjectSettings(defaults, true, [
        {
          viewportLayer: false,
          designResolution: { width: 400, height: 300 },
          scaleRule: "fitHeight",
        },
        {
          viewportLayer: true,
          designResolution: { width: 1280, height: 720 },
          scaleRule: "fitWidth",
        },
        {
          viewportLayer: true,
          designResolution: { width: 800, height: 600 },
          scaleRule: "shortestSide",
        },
      ]),
    ).toEqual({
      designResolution: { width: 1280, height: 720 },
      scaleRule: "fitWidth",
    });
  });

  it("falls back to the default design space when no viewport-layer HUD exists", () => {
    expect(
      seedUiProjectSettings(defaults, true, [
        {
          viewportLayer: false,
          designResolution: { width: 400, height: 300 },
        },
      ]),
    ).toEqual(defaults);
  });
});
