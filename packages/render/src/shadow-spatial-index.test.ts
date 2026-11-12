import { describe, expect, it } from "vitest";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Scene } from "@babylonjs/core/scene";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShadowSpatialIndex } from "./shadow-spatial-index";

describe("shadow caster spatial selection", () => {
  it("retains skinned casters whose bind-pose bounds cannot describe the animated pose", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowSpatialIndex();
      const mesh = MeshBuilder.CreateBox("animated caster", {}, scene);
      mesh.position.x = 100;
      mesh.skeleton = new Skeleton("rig", "rig", scene);
      index.add(mesh);
      expect(index.queryPlanes([new Plane(-1, 0, 0, 10)])).toContain(mesh);
      mesh.setEnabled(false);
      expect(index.queryPlanes([new Plane(-1, 0, 0, 10)])).not.toContain(mesh);
      index.dispose();
    } finally {
      engine.dispose();
    }
  });
  it("gives, of the meshes asked for and the instances they draw, the casters a whole query would", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowSpatialIndex();
      const inside = MeshBuilder.CreateBox("inside", {}, scene);
      const other = MeshBuilder.CreateBox("other", {}, scene);
      const outside = MeshBuilder.CreateBox("outside", {}, scene);
      outside.position.x = 100;
      const source = MeshBuilder.CreateBox("source", {}, scene);
      const near = source.createInstance("near"), far = source.createInstance("far"), hidden = source.createInstance("hidden");
      far.position.x = 100;
      hidden.isVisible = false;
      const stranger = MeshBuilder.CreateBox("not a caster", {}, scene);
      for (const mesh of [inside, other, outside, source, near, far, hidden]) index.add(mesh);
      // x <= 10.
      const planes = [new Plane(-1, 0, 0, 10)];
      const whole = index.queryPlanes(planes).slice();
      expect(whole).toEqual(expect.arrayContaining([inside, other, source, near]));
      const asked = new Set([inside, outside, source, near, stranger]);
      const scoped = index.queryPlanesOf(asked, planes);
      // `other` was not asked for; `near` is listed once though asked for itself and as an instance of `source`.
      expect([...scoped].sort((a, b) => a.uniqueId - b.uniqueId)).toEqual([inside, source, near].sort((a, b) => a.uniqueId - b.uniqueId));
      for (const mesh of scoped) expect(whole).toContain(mesh);
      expect(index.queryPlanesOf(new Set(), planes)).toEqual([]);
      index.dispose();
    } finally {
      engine.dispose();
    }
  });
  it("refits off-screen descendants when nested parents move or are replaced", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowSpatialIndex();
      const parent = new TransformNode("moving actor", scene);
      const importedRoot = new TransformNode("imported model root", scene);
      importedRoot.parent = parent;
      const child = MeshBuilder.CreateBox("caster", {}, scene);
      child.parent = importedRoot;
      index.add(child);
      const plane = new Plane(-1, 0, 0, 10);
      expect(index.queryPlanes([plane])).toContain(child);
      parent.position.x = 100;
      parent.computeWorldMatrix(true);
      expect(index.queryPlanes([plane])).not.toContain(child);
      parent.position.x = 0;
      parent.computeWorldMatrix(true);
      expect(index.queryPlanes([plane])).toContain(child);
      const replacement = new TransformNode("replacement parent", scene);
      importedRoot.parent = replacement;
      importedRoot.computeWorldMatrix(true);
      replacement.position.x = 100;
      replacement.computeWorldMatrix(true);
      expect(index.queryPlanes([plane])).not.toContain(child);
      index.dispose();
    } finally {
      engine.dispose();
    }
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
      index.add(upstream);
      index.add(distant);
      const volume = [
        new Plane(1, 0, 0, 10),
        new Plane(-1, 0, 0, 10),
        new Plane(0, 0, 1, 10),
        new Plane(0, 0, -1, 10),
        new Plane(0, 1, 0, 10),
      ];
      expect(index.queryPlanes(volume)).toEqual([upstream]);
      // Per-frame callers reuse one list; an earlier query's casters must not remain.
      const reused = [distant];
      expect(index.queryPlanes(volume, reused)).toBe(reused);
      expect(reused).toEqual([upstream]);
      distant.position.copyFrom(Vector3.Zero());
      distant.computeWorldMatrix(true);
      expect(index.queryPlanes(volume)).toContain(distant);
      index.remove(upstream);
      expect(index.queryPlanes(volume)).toEqual([distant]);
    } finally {
      engine.dispose();
    }
  });
});
