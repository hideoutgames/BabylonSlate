import { expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "./project";
import { normalizeSceneSettings } from "./scene";
import {
  normalizeEnvironmentLightingOverrides,
  resolveEnvironmentLightingSettings,
} from "./environment-lighting";

it("preserves existing environment appearance and disabled authored values across project and scene round trips", () => {
  expect(normalizeProjectSettings({}).render.environmentLighting).toEqual({
    enabled: true,
    intensity: 1,
    rotationYDegrees: 0,
    celStrength: 0,
  });
  expect(
    createEmptyProject("Demo").settings.render.environmentLighting,
  ).toMatchObject({ enabled: true, celStrength: 0 });
  const scene = normalizeSceneSettings({
    environmentTextureGuid: "environment",
    environmentLighting: {
      enabled: false,
      intensity: 3,
      rotationYDegrees: -90,
      celStrength: 0.5,
    },
  });
  expect(
    normalizeSceneSettings(JSON.parse(JSON.stringify(scene))),
  ).toMatchObject({
    environmentTextureGuid: "environment",
    environmentLighting: {
      enabled: false,
      intensity: 3,
      rotationYDegrees: -90,
      celStrength: 0.5,
    },
  });
});

it("resumes independent live project inheritance when a scene override is reset", () => {
  const scene = normalizeSceneSettings({
    environmentLighting: { intensity: 0, enabled: false },
  });
  const project = { intensity: 2, rotationYDegrees: 60 };
  expect(
    resolveEnvironmentLightingSettings(project, scene.environmentLighting),
  ).toEqual({
    enabled: false,
    intensity: 0,
    rotationYDegrees: 60,
    celStrength: 0,
  });
  delete scene.environmentLighting!.intensity;
  expect(
    resolveEnvironmentLightingSettings(
      { ...project, intensity: 4 },
      scene.environmentLighting,
    ),
  ).toMatchObject({ enabled: false, intensity: 4 });
});

it("rejects nonfinite or mistyped fields and bounds values before shader binding", () => {
  expect(
    normalizeEnvironmentLightingOverrides({
      enabled: "false",
      intensity: NaN,
      rotationYDegrees: Infinity,
      celStrength: null,
      unknown: 1,
    }),
  ).toEqual({});
  expect(
    normalizeEnvironmentLightingOverrides({
      intensity: 100,
      rotationYDegrees: -181,
      celStrength: -1,
    }),
  ).toEqual({ intensity: 64, rotationYDegrees: -180, celStrength: 0 });
});
