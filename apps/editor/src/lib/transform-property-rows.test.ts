import { describe, expect, it, vi } from "vitest";
import { identitySerializedTransform } from "@babylonslate/core";
import { spatialTransformPropertyRows } from "./transform-property-rows";

describe("spatialTransformPropertyRows", () => {
  it("shows Position XYZ in 3D and omits Z-Order", () => {
    const rows = spatialTransformPropertyRows(
      "actor",
      "3d",
      identitySerializedTransform(),
      vi.fn(),
    );
    const position = rows.find((row) => row.id === "actor-position");
    expect(position).toMatchObject({
      kind: "vector3",
      label: "Position",
      axes: ["X", "Y", "Z"],
    });
    expect(rows.find((row) => row.id === "actor-z-order")).toBeUndefined();
  });

  it("shows Position XY plus a Z-Order scalar in 2D", () => {
    const transform = {
      ...identitySerializedTransform(),
      position: [1, 2, 3] as [number, number, number],
    };
    const rows = spatialTransformPropertyRows("actor", "2d", transform, vi.fn());
    expect(rows.find((row) => row.id === "actor-position")).toMatchObject({
      kind: "vector3",
      label: "Position",
      axes: ["X", "Y"],
    });
    expect(rows.find((row) => row.id === "actor-z-order")).toMatchObject({
      kind: "number",
      label: "Z-Order",
      value: 3,
    });
  });

  it("writes Z-Order into transform.position z without changing XY", () => {
    const onUpdate = vi.fn();
    const transform = {
      ...identitySerializedTransform(),
      position: [4, 5, 0] as [number, number, number],
    };
    const rows = spatialTransformPropertyRows("mesh", "2d", transform, onUpdate);
    const zOrder = rows.find((row) => row.id === "mesh-z-order");
    expect(zOrder?.kind).toBe("number");
    if (zOrder?.kind !== "number") return;
    zOrder.onChange(9);
    expect(onUpdate).toHaveBeenCalledWith({
      ...transform,
      position: [4, 5, 9],
    });
  });
});
