import { describe, expect, it } from "vitest";
import {
  findGlobalParameter,
  globalParameterStartValue,
  normalizeGlobalParameterCatalog,
  normalizeGlobalParameterCollection,
  uniqueGlobalParameterName,
} from "./global-parameters";

describe("global parameter collections", () => {
  it("keeps valid parameters, sized to their type, and makes repeated names unique", () => {
    expect(normalizeGlobalParameterCollection({
      parameters: [
        { id: "wind", name: " Wind ", type: "vec3", defaultValue: [2] },
        { id: "tint", name: "Tint", type: "color", defaultValue: [1, 0, 0] },
        { id: "rect", name: "Rect", type: "vec4", defaultValue: [1, 0, 0] },
        { id: "wind", name: "Again", type: "float", defaultValue: [1] },
        { id: "copy", name: "Wind", type: "vec2" },
        { id: "bad", name: "Bad", type: "texture" },
        { id: "", name: "No Id", type: "float" },
      ],
    })).toEqual({
      parameters: [
        { id: "wind", name: "Wind", type: "vec3", defaultValue: [2, 2, 2] },
        { id: "tint", name: "Tint", type: "color", defaultValue: [1, 0, 0, 1] },
        // A Vector4's missing component is 0: only a Color's alpha starts at 1.
        { id: "rect", name: "Rect", type: "vec4", defaultValue: [1, 0, 0, 0] },
        { id: "copy", name: "Wind_1", type: "vec2", defaultValue: [0, 0] },
      ],
    });
    expect(normalizeGlobalParameterCollection(null)).toEqual({ parameters: [] });
  });

  it("names, starts and finds parameters", () => {
    const taken = [{ id: "a", name: "Parameter" }, { id: "b", name: "Parameter_1" }];
    expect(uniqueGlobalParameterName(taken)).toBe("Parameter_2");
    expect(uniqueGlobalParameterName(taken, "Parameter", "a")).toBe("Parameter");
    expect(globalParameterStartValue("color")).toEqual([1, 1, 1, 1]);
    expect(globalParameterStartValue("vec2")).toEqual([0, 0]);
    expect(globalParameterStartValue("vec4")).toEqual([0, 0, 0, 0]);
    const catalog = normalizeGlobalParameterCatalog({ fx: [{ id: "heat", name: "Heat", type: "float", defaultValue: [3] }], " ": [] });
    expect(Object.keys(catalog)).toEqual(["fx"]);
    expect(findGlobalParameter(catalog, "fx", "heat")?.name).toBe("Heat");
    expect(findGlobalParameter(catalog, "fx", "gone")).toBeNull();
  });
});
