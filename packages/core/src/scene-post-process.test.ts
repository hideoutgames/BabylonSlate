import { expect, it } from "vitest";
import { normalizeScenePostProcessStack, normalizeScene } from "./scene";
import { normalizeProjectSettings } from "./project";

it("round-trips independent typed entry overrides and copies valid values without retaining malformed data", () => {
  const tint = [2, 0.5, 0.25, 1];
  const input = [{ id: "first", materialGuid: "gain", enabled: false, parameters: {
    Gain: { kind: "float", value: 0.25 }, Tint: { kind: "color", value: tint },
    Mask: { kind: "texture", textureAssetGuid: "mask" }, Cleared: { kind: "texture", textureAssetGuid: null },
    Invalid: { kind: "float", value: NaN }, WrongColor: { kind: "color", value: [1, 2] },
    Unknown: { kind: "function", value: "code" },
  } }, { id: "second", materialGuid: "gain", parameters: { Gain: { kind: "float", value: 0.75 } } }];
  const stack = normalizeScenePostProcessStack(input);
  tint[0] = 99;
  expect(stack[0]!.parameters).toEqual({
    Gain: { kind: "float", value: 0.25 }, Tint: { kind: "color", value: [2, 0.5, 0.25, 1] },
    Mask: { kind: "texture", textureAssetGuid: "mask" }, Cleared: { kind: "texture", textureAssetGuid: null },
  });
  const restored = normalizeScene(JSON.parse(JSON.stringify({ settings: { postProcessStack: [...stack].reverse() } })));
  expect(restored.settings.postProcessStack).toEqual([...stack].reverse());
});

it("preserves pass IDs through edits and round trips", () => {
  const stack = normalizeScenePostProcessStack([
    { id: "blur-a", materialGuid: "blur" },
    { id: "blur-b", materialGuid: "blur", scalable: true },
  ]);
  const edited = [{ ...stack[1]!, materialGuid: "tint", enabled: false }, stack[0]!];
  const saved = JSON.parse(JSON.stringify(normalizeScene({ settings: { postProcessStack: edited } })));
  expect(normalizeScene(saved).settings.postProcessStack).toEqual(edited);
});

it("keeps the Scene Layer post-processing Project Setting's passes by the Scene's rules, without Scalable", () => {
  expect(normalizeProjectSettings(undefined).sceneLayerPostProcessStack).toEqual([]);
  const settings = normalizeProjectSettings(JSON.parse(JSON.stringify({ sceneLayerPostProcessStack: [
    { id: "glow", materialGuid: "glow-material", scalable: true, parameters: { Gain: { kind: "float", value: 2 } } },
    { id: "glow", materialGuid: "repeated-id" },
    { id: "tint", materialGuid: "tint-material", enabled: false },
    { materialGuid: "no-id" },
  ] })));
  expect(settings.sceneLayerPostProcessStack).toEqual([
    { id: "glow", materialGuid: "glow-material", enabled: true, parameters: { Gain: { kind: "float", value: 2 } } },
    { id: "tint", materialGuid: "tint-material", enabled: false },
  ]);
  // A saved project reads back the same passes in the same order.
  expect(normalizeProjectSettings(JSON.parse(JSON.stringify(settings))).sceneLayerPostProcessStack)
    .toEqual(settings.sceneLayerPostProcessStack);
});

it("keeps only entries with a material and an id no earlier entry uses", () => {
  const stack = normalizeScenePostProcessStack([
    null,
    { materialGuid: "a" },
    { id: " ", materialGuid: "b" },
    { id: "same", materialGuid: "c" },
    { id: "same", materialGuid: "d" },
    { id: "other" },
  ]);
  expect(stack).toEqual([{ id: "same", materialGuid: "c", enabled: true }]);
});
