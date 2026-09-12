import { describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Plane, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { ShadowSpatialIndex } from "./shadow-spatial-index";

describe("shadow caster spatial selection", () => {
  it("refits an off-screen child when its parent moves", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowSpatialIndex();
      const parent = new TransformNode("moving actor", scene);
      const child = MeshBuilder.CreateBox("caster", {}, scene);
      child.parent = parent;
      index.add(child);
      const plane = new Plane(-1, 0, 0, 10);
      expect(index.queryPlanes([plane])).toContain(child);
      parent.position.x = 100;
      parent.computeWorldMatrix(true);
      expect(index.queryPlanes([plane])).not.toContain(child);
      parent.position.x = 0;
      parent.computeWorldMatrix(true);
      expect(index.queryPlanes([plane])).toContain(child);
      index.dispose();
    } finally { engine.dispose(); }
  });
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
