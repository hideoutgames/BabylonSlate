import { describe, expect, it } from "vitest";
import {
  copyMaterialParameterValue,
  isFiniteMaterialParameterValue,
  normalizeMaterialParameterOverrides,
} from "./material-parameter-value";

describe("material parameter values", () => {
  it("keeps Vector2 and Vector3 overrides of exactly their width", () => {
    expect(normalizeMaterialParameterOverrides({
      Tiling: { kind: "vec2", value: [2, 4] },
      Glow: { kind: "vec3", value: [0.1, 0.2, 0.3] },
      Short: { kind: "vec3", value: [1, 2] },
      Long: { kind: "vec2", value: [1, 2, 3] },
      Bad: { kind: "vec2", value: [1, Number.NaN] },
    })).toEqual({
      Tiling: { kind: "vec2", value: [2, 4] },
      Glow: { kind: "vec3", value: [0.1, 0.2, 0.3] },
    });
  });

  it("copies without sharing arrays and checks each kind's values", () => {
    const glow = { kind: "vec3" as const, value: [1, 2, 3] as [number, number, number] };
    const copy = copyMaterialParameterValue(glow);
    expect(copy).toEqual(glow);
    expect(copy.kind === "vec3" && copy.value).not.toBe(glow.value);
    expect(isFiniteMaterialParameterValue({ kind: "vec2", value: [1, 2] })).toBe(true);
    expect(isFiniteMaterialParameterValue({ kind: "vec3", value: [1, 2, Infinity] })).toBe(false);
    expect(isFiniteMaterialParameterValue({ kind: "texture", textureAssetGuid: null })).toBe(true);
  });
});
