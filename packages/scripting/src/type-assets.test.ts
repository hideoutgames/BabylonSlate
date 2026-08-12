import { describe, expect, it } from "vitest";
import {
  createEmptyEnum,
  createEmptyFunctionLibrary,
  createEmptyScriptInterface,
  createEmptyStructure,
} from "./type-assets";

describe("type assets", () => {
  it("creates empty enum/structure/interface/function library", () => {
    expect(createEmptyEnum("g1", "ETeam").members[0]?.name).toBe("None");
    expect(createEmptyStructure("g2", "FHit").fields).toEqual([]);
    expect(createEmptyScriptInterface("g3", "IDamageable").methods).toEqual([]);
    expect(createEmptyFunctionLibrary("g4", "MathLib").parentClass).toBe(
      "FunctionLibrary",
    );
  });
});
