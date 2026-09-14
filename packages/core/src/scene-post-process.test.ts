import { expect, it } from "vitest";
import { normalizeScenePostProcessStack, normalizeScene } from "./scene";
import { normalizeSceneLayer } from "./scene-layer";

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
