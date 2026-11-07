import { describe, expect, it } from "vitest";
import { actorsHaveLights2D, light2DBindings, parseLight2DProperties } from "./light-2d";
import { identitySerializedTransform } from "./scene";
import { parseSurfaceShadingMode } from "./surface-shading";

describe("2D Light authoring", () => {
  it("defaults a missing light to a white full-circle Point light", () => {
    expect(parseLight2DProperties(undefined)).toEqual({
      enabled: true, lightKind: "point", color: [1, 1, 1], intensity: 1, radius: 3, innerRadius: 0, outerAngle: 360, innerAngle: 360,
      castShadows: true,
    });
  });

  it.each([
    ["a non-positive radius", { radius: 0 }, { radius: 3 }],
    ["an inner radius past the radius", { radius: 2, innerRadius: 5 }, { radius: 2, innerRadius: 2 }],
    ["a negative inner radius", { innerRadius: -1 }, { innerRadius: 0 }],
    ["an outer angle past a full turn", { outerAngle: 400 }, { outerAngle: 360, innerAngle: 360 }],
    ["an inner angle wider than the outer one", { outerAngle: 60, innerAngle: 90 }, { outerAngle: 60, innerAngle: 60 }],
    ["an inner angle left unset", { outerAngle: 60 }, { outerAngle: 60, innerAngle: 60 }],
    ["a negative intensity", { intensity: -2 }, { intensity: 0 }],
    ["colour channels out of range", { color: [-1, 0.5, 3] }, { color: [0, 0.5, 1] }],
    ["a malformed colour", { color: [1, "red", 0] }, { color: [1, 1, 1] }],
    ["an unknown kind", { lightKind: "spot" }, { lightKind: "point" }],
    ["the Global kind", { lightKind: "global" }, { lightKind: "global" }],
    ["Enabled off", { enabled: false }, { enabled: false }],
    ["Cast Shadows off", { castShadows: false }, { castShadows: false }],
  ])("normalizes %s", (_label, input, expected) => {
    expect(parseLight2DProperties(input)).toMatchObject(expected);
  });

  it("keeps each light's attachment chain, light first, and isolates a broken attachment", () => {
    const parent = identitySerializedTransform(); parent.position = [0, 2, 0];
    const child = identitySerializedTransform(); child.position = [1, 0, 0];
    const bindings = light2DBindings([
      { id: "arm", classId: "SceneComponent", properties: {}, parentId: null, transform: parent },
      { id: "lamp", classId: "Light2DComponent", properties: { radius: 5 }, parentId: "arm", transform: child },
      { id: "orphan", classId: "Light2DComponent", properties: {}, parentId: "gone", transform: child },
      { id: "sprite", classId: "SpriteComponent", properties: {}, parentId: null },
    ]);
    expect(bindings.map((binding) => binding.id)).toEqual(["lamp", "orphan"]);
    expect(bindings[0]).toMatchObject({ transforms: [child, parent], properties: { radius: 5 } });
    expect(bindings[0]!.error).toBeUndefined();
    expect(bindings[1]!.error).toBe("2D Light has a missing component attachment.");
  });

  it("finds whether any actor holds a 2D Light", () => {
    expect(actorsHaveLights2D([{ components: [{ classId: "SpriteComponent" }] }, { components: [{ classId: "Light2DComponent" }] }])).toBe(true);
    expect(actorsHaveLights2D([{ components: [{ classId: "LightComponent" }, { classId: "SpriteComponent" }] }])).toBe(false);
  });
});

describe("Shading Mode", () => {
  it.each([["3d", "3d"], ["unlit", "unlit"], ["2d", "2d"], [undefined, "2d"], ["lit", "2d"]] as const)(
    "reads %s as %s", (value, expected) => {
      expect(parseSurfaceShadingMode(value)).toBe(expected);
    });
});
