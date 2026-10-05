import { describe, expect, it } from "vitest";
import { deformerBindings, parseDeformerProperties, updateDeformerProperties } from "./deformer-component";
import { normalizeScene, type SerializedComponent } from "./scene";

describe("deformer component authoring", () => {
  it("bounds untrusted cages and retains finite offsets through scene round trips", () => {
    const offsets = [1, NaN, Infinity, -2];
    const properties = parseDeformerProperties({ enabled: true, resolution: [9, 3.2, -1], strength: 8, offsets,
      fitToMesh: false, boundsMin: [2, 0, 0], boundsMax: [1, 3, 4] });
    expect(properties.resolution).toEqual([4, 3, 2]);
    expect(properties.offsets).toHaveLength(72);
    expect(properties.offsets.slice(0, 6)).toEqual([1, 0, 0, -2, 0, 0]);
    expect(properties.boundsMin).toEqual([-0.5, 0, 0]);
    expect(properties.boundsMax).toEqual([0.5, 3, 4]);
    expect(properties.strength).toBe(1);
    expect(parseDeformerProperties({}).enabled).toBe(false);
    expect(parseDeformerProperties({ resolution: [4, 4, 4], offsets: Array(300).fill(1) }).offsets).toHaveLength(192);
    const extreme = parseDeformerProperties({ offsets: [1e308, -1e308], boundsMin: [-1e308, -1, -1], boundsMax: [1e308, 1, 1] });
    expect(extreme.offsets.slice(0, 2)).toEqual([10_000_000_000, -10_000_000_000]);
    expect(extreme.boundsMin[0]).toBe(-10_000_000_000);
    expect(extreme.boundsMax[0]).toBe(10_000_000_000);
    const restored = normalizeScene(JSON.parse(JSON.stringify({ actors: [{ id: "owner", components: [
      { id: "cage", classId: "DeformerComponent", sourceId: "template-cage", overrideKeys: ["offsets"], properties },
    ] }] })));
    expect(restored.actors[0]!.components[0]).toMatchObject({ sourceId: "template-cage", overrideKeys: ["offsets"], properties });
    const changed = updateDeformerProperties(properties, "resolution", [2, 2, 2]);
    expect(changed.offsets).toEqual(Array(24).fill(0));
    expect(properties.offsets[0]).toBe(1);
  });

  it("resolves inherited targets within the owner, gives exact IDs precedence and ignores disabled duplicates", () => {
    const components: SerializedComponent[] = [
      { id: "inherited", sourceId: "mesh", classId: "MeshComponent", properties: {} },
      { id: "mesh", classId: "MeshComponent", properties: {} },
      { id: "off", classId: "DeformerComponent", properties: { enabled: false, targetMeshComponentId: "mesh" } },
      { id: "active", classId: "DeformerComponent", properties: { enabled: true, targetMeshComponentId: "mesh", offsets: [1, 2, 3] } },
      { id: "duplicate", classId: "DeformerComponent", properties: { enabled: true, targetMeshComponentId: "mesh" } },
      { id: "foreign", classId: "DeformerComponent", properties: { enabled: true, targetMeshComponentId: "other-actor-mesh" } },
    ];
    const first = deformerBindings("owner", components);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "active", targetMeshComponentId: "mesh" });
    first[0]!.offsets[0] = 99;
    expect(deformerBindings("owner", components)[0]!.offsets[0]).toBe(1);
    expect(deformerBindings("owner", components.filter((c) => c.id !== "mesh"))[0]!.targetMeshComponentId).toBe("inherited");
    expect(deformerBindings("other", components.filter((c) => c.classId !== "MeshComponent"))).toEqual([]);
  });
});
