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

it("migrates duplicate-material passes deterministically and preserves IDs through edits and round trips", () => {
  const input = [{ materialGuid: "blur" }, { materialGuid: "blur", scalable: true }];
  const stack = normalizeScenePostProcessStack(input);
  expect(stack).toEqual(normalizeScenePostProcessStack(input));
  expect(new Set(stack.map((entry) => entry.id)).size).toBe(2);
  const edited = [{ ...stack[1]!, materialGuid: "tint", enabled: false }, stack[0]!];
  for (const normalize of [normalizeScene, normalizeSceneLayer]) {
    const saved = JSON.parse(JSON.stringify(normalize({ settings: { postProcessStack: edited } })));
    expect(normalize(saved).settings.postProcessStack).toEqual(edited);
  }
});

it("repairs missing and duplicate IDs without stealing a later authored identity", () => {
  const stack = normalizeScenePostProcessStack([
    null,
    { materialGuid: "a" },
    { id: "legacy-pass-1", materialGuid: "b" },
    { id: "same", materialGuid: "c" },
    { id: "same", materialGuid: "d" },
  ]);
  expect(stack[1]!.id).toBe("legacy-pass-1");
  expect(stack[2]!.id).toBe("same");
  expect(new Set(stack.map((entry) => entry.id)).size).toBe(4);
  expect(normalizeScenePostProcessStack(stack)).toEqual(stack);
});
