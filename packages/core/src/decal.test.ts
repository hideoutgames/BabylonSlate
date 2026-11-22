import { describe, expect, it } from "vitest";
import { DECAL_CLASS_ID, DEFAULT_DECAL_PROPERTIES, decalBindings, parseDecalProperties } from "./decal";
import { identitySerializedTransform } from "./scene";

describe("decal core schema", () => {
  it("parses defaults and clamps invalid ranges", () => {
    expect(parseDecalProperties({})).toEqual(DEFAULT_DECAL_PROPERTIES);
    expect(
      parseDecalProperties({
        enabled: false,
        materialGuid: "  decal-mat  ",
        tint: [2, -1, 0.5],
        opacity: 4,
        size: [-2, 0, 5],
        fadeAngle: 999,
        sortOrder: 3.6,
        cullDistance: -10,
      }),
    ).toEqual({
      enabled: false,
      materialGuid: "decal-mat",
      tint: [1, 0, 0.5],
      opacity: 1,
      size: [2, 1, 5],
      fadeAngle: 180,
      sortOrder: 4,
      cullDistance: 0,
    });
    expect(parseDecalProperties({ materialGuid: "   " }).materialGuid).toBeNull();
  });

  it("carries the component's parameter values only for its current Material", () => {
    const parameters = { Tint: { kind: "color" as const, value: [1, 0, 0, 1] as [number, number, number, number] } };
    const [current, stale, none] = decalBindings([
      { id: "current", classId: DECAL_CLASS_ID, properties: { materialGuid: "mud" }, materialInstance: { materialGuid: "mud", parameters } },
      { id: "stale", classId: DECAL_CLASS_ID, properties: { materialGuid: "mud" }, materialInstance: { materialGuid: "scorch", parameters } },
      { id: "none", classId: DECAL_CLASS_ID, properties: { materialGuid: "mud" } },
    ]);
    expect(current!.materialInstance).toEqual({ materialGuid: "mud", parameters });
    expect(stale!.materialInstance).toBeUndefined();
    expect(none!.materialInstance).toBeUndefined();
  });

  it("collects component attachment chains and reports invalid attachments", () => {
    const parent = { ...identitySerializedTransform(), position: [1, 2, 3] as [number, number, number] };
    const child = { ...identitySerializedTransform(), position: [0, 1, 0] as [number, number, number] };
    const bindings = decalBindings([
      { id: "root", classId: "MeshComponent", properties: {}, transform: parent },
      { id: "decal", classId: DECAL_CLASS_ID, parentId: "root", properties: { materialGuid: "scorch", size: [3, 1, 3] }, transform: child },
      { id: "cycle", classId: DECAL_CLASS_ID, parentId: "cycle", properties: {} },
      { id: "missing", classId: DECAL_CLASS_ID, parentId: "absent", properties: {} },
    ]);
    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toMatchObject({
      id: "decal",
      properties: { materialGuid: "scorch", size: [3, 1, 3] },
      transforms: [child, parent],
    });
    expect(bindings[0]!.error).toBeUndefined();
    expect(bindings[1]!.error).toMatch(/cyclic/i);
    expect(bindings[2]!.error).toMatch(/missing/i);
  });
});
