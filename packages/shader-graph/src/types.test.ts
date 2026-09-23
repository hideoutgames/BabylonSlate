import { describe, expect, it } from "vitest";
import {
  componentCount,
  conversionFor,
  convertMaterialValue,
  isNumericType,
  materialTypeLabel,
  resolveGenericType,
  typesAreAssignable,
} from "./types";

describe("material value types", () => {
  it("reports component counts for numeric types", () => {
    expect(componentCount("float")).toBe(1);
    expect(componentCount("vec2")).toBe(2);
    expect(componentCount("vec3")).toBe(3);
    expect(componentCount("vec4")).toBe(4);
    expect(componentCount("texture")).toBe(0);
  });

  it("treats only float and vectors as numeric", () => {
    expect(isNumericType("float")).toBe(true);
    expect(isNumericType("vec4")).toBe(true);
    expect(isNumericType("texture")).toBe(false);
  });

  it.each([
    ["float", [2], [[2], [2, 1], [2, 1, 1], [2, 1, 1, 1]]],
    ["float", [0], [[0], [0, 1], [0, 1, 1], [0, 1, 1, 1]]],
    ["vec2", [2, 0], [[2], [2, 0], [2, 0, 1], [2, 0, 1, 1]]],
    ["vec3", [2, -3, 0], [[2], [2, -3], [2, -3, 0], [2, -3, 0, 1]]],
    ["vec4", [2, -3, 4, 0], [[2], [2, -3], [2, -3, 4], [2, -3, 4, 0]]],
  ] as const)("converts %s to every numeric width without broadcasting", (from, value, expected) => {
    for (const [index, to] of (["float", "vec2", "vec3", "vec4"] as const).entries()) {
      expect(typesAreAssignable(from, to)).toBe(true);
      const conversion = conversionFor(from, to);
      expect(conversion ? convertMaterialValue(value, conversion) : value).toEqual(expected[index]);
    }
  });

  it("needs no conversion for identical types", () => {
    expect(conversionFor("vec2", "vec2")).toBeNull();
    expect(typesAreAssignable("texture", "texture")).toBe(true);
  });

  it("never mixes textures with numerics", () => {
    expect(typesAreAssignable("texture", "vec4")).toBe(false);
    expect(typesAreAssignable("float", "texture")).toBe(false);
  });

  it("resolves a generic group to the widest connected vector", () => {
    expect(resolveGenericType(["float", "vec3", "float"])).toEqual({
      ok: true,
      type: "vec3",
    });
  });

  it("defaults an unconnected generic group to float", () => {
    expect(resolveGenericType([])).toEqual({ ok: true, type: "float" });
  });

  it.each([
    ["vec2", "vec3", "float"],
    ["float", "vec3", "vec2"],
    ["vec3", "vec2", "float"],
  ] as const)("resolves mixed widths independently of order: %s %s %s", (...types) => {
    expect(resolveGenericType(types)).toEqual({ ok: true, type: "vec3" });
  });

  it("rejects a generic group containing a texture", () => {
    expect(resolveGenericType(["float", "texture"]).ok).toBe(false);
  });

  it("labels types in Title Case for diagnostics", () => {
    expect(materialTypeLabel("vec3")).toBe("Vector 3");
    expect(materialTypeLabel("float")).toBe("Float");
    expect(materialTypeLabel("texture")).toBe("Texture");
  });
});
