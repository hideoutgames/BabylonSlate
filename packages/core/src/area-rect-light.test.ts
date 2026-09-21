import { describe, expect, it } from "vitest";
import { areaRectLightBindings, areaEmissionTextureGuids, parseAreaRectLightProperties } from "./area-rect-light";
import { identitySerializedTransform } from "./scene";

describe("rectangular area light authoring", () => {
  it("tracks typed component and script emission references without scanning ordinary strings", () => {
    expect(areaEmissionTextureGuids({ components: [{ classId: "AreaRectLightComponent", properties: { textureGuid: "one" } }], graph: { nodes: [{ data: { properties: { classId: "AreaRectLightComponent", variableName: "EmissionTexture", propertyKey: "textureGuid", "default:EmissionTexture": "two" } } }] }, text: "unused", unrelated: { classId: "MeshComponent", properties: { textureGuid: "three" } } })).toEqual(["one", "two"]);
  });
  it("normalizes invalid documents without serializing native resources", () => {
    expect(parseAreaRectLightProperties({ width: NaN, height: -2, intensity: Infinity, color: [-1, 0.5, 4], textureGuid: " tex ", castShadows: true })).toEqual({
      enabled: true, width: 1, height: 1, intensity: 1, color: [0, 0.5, 1], textureGuid: "tex",
    });
    expect(parseAreaRectLightProperties({ enabled: false, intensity: 0 }).intensity).toBe(0);
  });

  it("preserves every attachment transform and isolates a broken emitter", () => {
    const parent = identitySerializedTransform(); parent.scale = [2, 3, 1];
    const child = identitySerializedTransform(); child.position = [1, 0, 0];
    const result = areaRectLightBindings([
      { id: "parent", classId: "ActorComponent", properties: {}, transform: parent },
      { id: "lamp", classId: "AreaRectLightComponent", parentId: "parent", properties: {}, transform: child },
      { id: "broken", classId: "AreaRectLightComponent", parentId: "broken", properties: {} },
    ]);
    expect(result[0]?.transforms).toEqual([child, parent]);
    expect(result[0]?.error).toBeUndefined();
    expect(result[1]?.error).toContain("cyclic");
  });
});
