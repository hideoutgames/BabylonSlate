import { describe, expect, it } from "vitest";
import { fogVolumeBindings, parseFogVolumeProperties } from "./fog-volume";
import { identitySerializedTransform, normalizeScene } from "./scene";

describe("fog volume authoring", () => {
  it("repairs invalid persisted values while retaining useful zero density and hard edges", () => {
    const scene = normalizeScene({ actors: [{ id: "fog", components: [{
      id: "volume", classId: "FogVolumeComponent",
      properties: { shape: "unknown", size: [-1, 4, NaN], density: Infinity, edgeFalloff: 8 },
    }] }] });
    expect(scene.actors[0]?.components[0]?.properties).toEqual({
      enabled: true, shape: "box", size: [10, 4, 10], density: 0.1, edgeFalloff: 1,
    });
    expect(parseFogVolumeProperties({ enabled: false, shape: "sphere", density: 0, edgeFalloff: 0 })).toEqual({
      enabled: false, shape: "sphere", size: [10, 10, 10], density: 0, edgeFalloff: 0,
    });
    expect(parseFogVolumeProperties({ density: -3, edgeFalloff: -2 })).toMatchObject({ density: 0, edgeFalloff: 0 });
  });

  it("keeps component attachment order and isolates broken volumes", () => {
    const parent = identitySerializedTransform();
    parent.scale = [2, 3, 4];
    const child = identitySerializedTransform();
    child.position = [1, 2, 3];
    const bindings = fogVolumeBindings([
      { id: "parent", classId: "ActorComponent", properties: {}, transform: parent },
      { id: "fog", classId: "FogVolumeComponent", parentId: "parent", properties: { size: [4, 6, 8] }, transform: child },
      { id: "cycle", classId: "FogVolumeComponent", parentId: "cycle", properties: {} },
      { id: "missing", classId: "FogVolumeComponent", parentId: "absent", properties: {} },
    ]);
    expect(bindings).toHaveLength(3);
    expect(bindings[0]?.transforms).toEqual([child, parent]);
    expect(bindings[0]?.properties.size).toEqual([4, 6, 8]);
    expect(bindings[0]?.error).toBeUndefined();
    expect(bindings[1]?.error).toContain("cyclic");
    expect(bindings[2]?.error).toContain("missing");
  });
});
