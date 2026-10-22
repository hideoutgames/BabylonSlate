import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { normalizeWaterRemoval } from "@haptic/core";
import { describe, expect, it } from "vitest";
import { createWaterRemovalMesh, waterRemovalOutline } from "./water-removal-mesh";

describe("water removal editor volume", () => {
  it("sizes the pick box to the outline the water is cut by", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      for (const properties of [
        { shape: "sphere", width: 2, height: 6, length: 8 },
        { shape: "capsule", width: 4, height: 2, length: 8 },
        { shape: "capsule", width: 2, height: 6, length: 8 },
        { shape: "cylinder", width: 2, height: 6, length: 8 },
        { shape: "box", width: 2, height: 6, length: 8 },
      ]) {
        const mesh = createWaterRemovalMesh(scene, properties.shape, properties, { editor: true });
        const pick = mesh.getChildMeshes().find((child) => child.name.endsWith(":pick"))!;
        const box = pick.getBoundingInfo().boundingBox;
        const outline = waterRemovalOutline(normalizeWaterRemoval(properties)).flat();
        const min = outline.reduce((low, point) => Vector3.Minimize(low, point));
        const max = outline.reduce((high, point) => Vector3.Maximize(high, point));
        for (const axis of ["x", "y", "z"] as const) {
          expect(box.minimum[axis], `${properties.shape} ${axis}`).toBeCloseTo(min[axis], 5);
          expect(box.maximum[axis], `${properties.shape} ${axis}`).toBeCloseTo(max[axis], 5);
        }
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
});
