import { describe, expect, it } from "vitest";
import {
  componentCount,
  conversionFor,
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

  it("splats a float into any vector but never truncates", () => {
    expect(typesAreAssignable("float", "vec3")).toBe(true);
    expect(conversionFor("float", "vec3")).toEqual({ kind: "splat", to: "vec3" });
    expect(typesAreAssignable("vec3", "vec2")).toBe(false);
    expect(typesAreAssignable("vec2", "vec4")).toBe(false);
    expect(typesAreAssignable("vec3", "float")).toBe(false);
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

  it("rejects a generic group mixing two different vector widths", () => {
    expect(resolveGenericType(["vec2", "vec3"])).toEqual({
      ok: false,
      conflict: ["vec2", "vec3"],
    });
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
