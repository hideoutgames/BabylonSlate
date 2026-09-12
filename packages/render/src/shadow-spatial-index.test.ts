import { describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Plane, Scene, Vector3 } from "@babylonjs/core";
import { ShadowSpatialIndex } from "./shadow-spatial-index";

describe("shadow caster spatial selection", () => {
  it("retains upstream casters and refits moved meshes without admitting unrelated distant geometry", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowSpatialIndex();
      const upstream = MeshBuilder.CreateBox("off-screen upstream", {}, scene);
      upstream.position.set(0, 1000, 0);
      const distant = MeshBuilder.CreateBox("unrelated", {}, scene);
      distant.position.set(10000, 0, 0);
      index.add(upstream); index.add(distant);
      const volume = [new Plane(1, 0, 0, 10), new Plane(-1, 0, 0, 10), new Plane(0, 0, 1, 10), new Plane(0, 0, -1, 10), new Plane(0, 1, 0, 10)];
      expect(index.queryPlanes(volume)).toEqual([upstream]);
      distant.position.copyFrom(Vector3.Zero()); distant.computeWorldMatrix(true);
      expect(index.queryPlanes(volume)).toContain(distant);
      index.remove(upstream);
      expect(index.queryPlanes(volume)).toEqual([distant]);
    } finally { engine.dispose(); }
  });
});
