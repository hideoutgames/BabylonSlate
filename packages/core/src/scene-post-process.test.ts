import { expect, it } from "vitest";
import { normalizeScenePostProcessStack, normalizeScene } from "./scene";
import { normalizeSceneLayer } from "./scene-layer";

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
  for (const normalize of [normalizeScene, normalizeSceneLayer]) {
    const restored = normalize(JSON.parse(JSON.stringify({ settings: { postProcessStack: [...stack].reverse() } })));
    expect(restored.settings.postProcessStack).toEqual([...stack].reverse());
  }
});

it("preserves pass IDs through edits and round trips", () => {
  const stack = normalizeScenePostProcessStack([
    { id: "blur-a", materialGuid: "blur" },
    { id: "blur-b", materialGuid: "blur", scalable: true },
  ]);
  const edited = [{ ...stack[1]!, materialGuid: "tint", enabled: false }, stack[0]!];
  for (const normalize of [normalizeScene, normalizeSceneLayer]) {
    const saved = JSON.parse(JSON.stringify(normalize({ settings: { postProcessStack: edited } })));
    expect(normalize(saved).settings.postProcessStack).toEqual(edited);
  }
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
