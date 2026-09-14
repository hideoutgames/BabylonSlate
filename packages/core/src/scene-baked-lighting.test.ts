import { expect, it } from "vitest";
import { normalizeScene } from "./scene";
import { createDefaultScene } from "./project";

it("preserves an additive bake reference through Scene JSON while legacy scenes keep it absent", () => {
  const scene = createDefaultScene();
  expect(normalizeScene(scene).settings).not.toHaveProperty(
    "bakedLightingAssetGuid",
  );
  expect(normalizeScene(scene).settings).not.toHaveProperty("bakeSettings");
  scene.settings.bakeSettings = { resolution: 64, paddingTexels: 3, samples: 128, bounces: 4 };
  expect(normalizeScene(JSON.parse(JSON.stringify(scene))).settings.bakeSettings).toEqual(scene.settings.bakeSettings);
  scene.settings.bakedLightingAssetGuid = "last-valid-bake";
  expect(
    normalizeScene(JSON.parse(JSON.stringify(scene))).settings
      .bakedLightingAssetGuid,
  ).toBe("last-valid-bake");
  scene.settings.bakedLightingAssetGuid = null;
  expect(normalizeScene(scene).settings).toHaveProperty(
    "bakedLightingAssetGuid",
    null,
  );
});
