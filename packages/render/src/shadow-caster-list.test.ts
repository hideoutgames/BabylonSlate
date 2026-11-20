import { describe, expect, it, vi } from "vitest";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Scene } from "@babylonjs/core/scene";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { setShadowDistanceCulled, ShadowCasterList, type CasterChanges } from "./shadow-caster-list";

/** The caster walk's change log as `prepare` reads it: what a test lists, and what the stages counted. */
function changeLog() {
  const log: Array<[AbstractMesh, boolean]> = [];
  const counted = { prepared: 0, prepareScans: 0, misses: 0 };
  let check: "verify" | "heal" | null = null;
  const changes: CasterChanges = {
    changeCursor: () => log.length,
    forEachChangeSince: (cursor, visit) => {
      for (let at = cursor; at < log.length; at++) visit(log[at]![0], log[at]![1]);
      return true;
    },
    stageCheck: () => check,
    noteStageMiss: (_kind, count = 1) => { counted.misses += count; },
    noteStage: (counter, count = 1) => { counted[counter] += count; },
  };
  return { log, counted, changes, checkNext: (mode: "verify" | "heal" | null) => { check = mode; } };
}

describe("a prepare from the walk's changes", () => {
  it("reads only the casters added or changed, gives what a full read would, and a check counts a kept box gone stale", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const { log, counted, changes, checkNext } = changeLog();
      const incremental = new ShadowCasterList();
      const meshes = ["a", "b", "c", "d"].map((name, index) => {
        const mesh = MeshBuilder.CreateBox(name, {}, scene);
        mesh.position.x = index * 5;
        mesh.computeWorldMatrix(true);
        incremental.add(mesh);
        return mesh;
      });
      const [a, , c, d] = meshes as unknown as [AbstractMesh, AbstractMesh, AbstractMesh, AbstractMesh];
      // x <= 7: a and b.
      const planes = [new Plane(-1, 0, 0, 7)];
      const query = () => incremental.queryPlanes(planes).map((mesh) => mesh.name).sort();
      incremental.prepare(undefined, changes);
      expect(counted).toMatchObject({ prepareScans: 1, prepared: 0 });
      expect(query()).toEqual(["a", "b"]);
      incremental.release();

      // A move the walk listed is read; nothing else is.
      c.position.x = 0;
      c.computeWorldMatrix(true);
      log.push([c, false]);
      incremental.prepare(undefined, changes);
      expect(counted).toMatchObject({ prepareScans: 1, prepared: 1 });
      expect(query()).toEqual(["a", "b", "c"]);
      incremental.release();

      // A removal moves the last caster into the place, with what was read of it; an added caster is read.
      incremental.remove(a);
      log.push([a, true]);
      const e = MeshBuilder.CreateBox("e", {}, scene);
      incremental.add(e);
      incremental.prepare(undefined, changes);
      expect(counted.prepared).toBe(2);
      expect(query()).toEqual(["b", "c", "e"]);
      incremental.release();

      // A box changed with no listed change keeps its old reading, which a frame with the full check counts.
      d.position.x = 0;
      d.computeWorldMatrix(true);
      incremental.prepare(undefined, changes);
      expect(query()).toEqual(["b", "c", "e"]);
      incremental.release();
      checkNext("verify");
      incremental.prepare(undefined, changes);
      expect(counted.misses).toBe(1);
      // Healed: the full read's answer is kept.
      expect(query()).toEqual(["b", "c", "d", "e"]);
      incremental.dispose();
    } finally {
      engine.dispose();
    }
  });
});

describe("shadow caster selection", () => {
  it("retains skinned casters whose bind-pose bounds cannot describe the animated pose", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowCasterList();
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
  it("excludes casters culled by shadow distance from both prepared and direct queries", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowCasterList();
      const mesh = MeshBuilder.CreateBox("foliage-cell", {}, scene);
      mesh.computeWorldMatrix(true);
      index.add(mesh);
      const planes = [new Plane(-1, 0, 0, 10)];
      expect(index.queryPlanes(planes)).toContain(mesh);
      setShadowDistanceCulled(mesh, true);
      expect(index.queryPlanes(planes)).not.toContain(mesh);
      index.prepare();
      expect(index.queryPlanes(planes)).not.toContain(mesh);
      index.release();
      setShadowDistanceCulled(mesh, false);
      index.prepare();
      expect(index.queryPlanes(planes)).toContain(mesh);
      index.release();
      index.dispose();
    } finally {
      engine.dispose();
    }
  });
  it("gives, of the meshes asked for and the instances they draw, the casters a whole query would", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowCasterList();
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
      const byId = (meshes: readonly { uniqueId: number }[]) => [...meshes].sort((a, b) => a.uniqueId - b.uniqueId);
      // `other` was not asked for; `near` is, as an instance `source` draws.
      const scoped = index.queryPlanesOf(new Set([inside, outside, source, stranger]), planes).slice();
      expect(byId(scoped)).toEqual(byId([inside, source, near]));
      for (const mesh of scoped) expect(whole).toContain(mesh);
      // Asked for itself too, before or after its source, an instance is listed once.
      expect(byId(index.queryPlanesOf(new Set([near, source]), planes))).toEqual(byId([source, near]));
      expect(byId(index.queryPlanesOf(new Set([source, near]), planes))).toEqual(byId([source, near]));
      expect(index.queryPlanesOf(new Set(), planes)).toEqual([]);
      index.dispose();
    } finally {
      engine.dispose();
    }
  });
  it("answers a prepared frame's queries from what it read once, as the casters would answer themselves", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowCasterList();
      const inside = MeshBuilder.CreateBox("inside", {}, scene);
      const edge = MeshBuilder.CreateBox("at the plane", {}, scene);
      edge.position.x = 10.5;
      const outside = MeshBuilder.CreateBox("outside", {}, scene);
      outside.position.x = 100;
      const hidden = MeshBuilder.CreateBox("hidden", {}, scene);
      hidden.isVisible = false;
      const skinned = MeshBuilder.CreateBox("skinned", {}, scene);
      skinned.position.x = 100;
      skinned.skeleton = new Skeleton("rig", "rig", scene);
      for (const mesh of [inside, edge, outside, hidden, skinned]) index.add(mesh);
      // x <= 10: the box at the plane touches it.
      const planes = [new Plane(-1, 0, 0, 10)];
      const live = index.queryPlanes(planes).slice();
      expect(live).toEqual([inside, edge, skinned]);
      // What the walk found of a caster stands for asking it; one the walk has not seen is asked.
      const enabled = vi.spyOn(inside, "isEnabled");
      index.prepare((mesh) => (mesh === inside ? { shown: true } : mesh === hidden ? { shown: false } : undefined));
      expect(enabled).not.toHaveBeenCalled();
      expect(index.queryPlanes(planes)).toEqual(live);
      expect(index.queryPlanesOf(new Set([edge, outside]), planes)).toEqual([edge]);
      // Until the frame ends nothing moves a caster: a query does not read them again.
      const box = vi.spyOn(edge, "getBoundingInfo");
      index.queryPlanes(planes);
      expect(box).not.toHaveBeenCalled();
      edge.position.x = 100;
      edge.computeWorldMatrix(true);
      index.release();
      expect(index.queryPlanes(planes)).toEqual([inside, skinned]);
      // A caster that joins or leaves ends what was read.
      index.remove(skinned);
      index.prepare();
      // The hidden caster takes the place of the one that left: it is not answered for with what that one was.
      index.remove(inside);
      expect(index.queryPlanes(planes)).toEqual([]);
      index.prepare();
      index.add(inside);
      expect(index.queryPlanes(planes)).toEqual([inside]);
      index.dispose();
    } finally {
      engine.dispose();
    }
  });
  it("follows descendants whose nested parents move or are replaced, once the caster walk has posed them", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const index = new ShadowCasterList();
      const parent = new TransformNode("moving actor", scene);
      const importedRoot = new TransformNode("imported model root", scene);
      importedRoot.parent = parent;
      const child = MeshBuilder.CreateBox("caster", {}, scene);
      child.parent = importedRoot;
      index.add(child);
      // As in a frame: a new render id, then the walk asks the caster for its world matrix.
      const posed = () => { scene.incrementRenderId(); child.computeWorldMatrix(); };
      const plane = new Plane(-1, 0, 0, 10);
      expect(index.queryPlanes([plane])).toContain(child);
      // A frame's caster walk asks every caster for its world matrix before any layer lists (`syncCasters`).
      parent.position.x = 100;
      posed();
      expect(index.queryPlanes([plane])).not.toContain(child);
      parent.position.x = 0;
      posed();
      expect(index.queryPlanes([plane])).toContain(child);
      const replacement = new TransformNode("replacement parent", scene);
      importedRoot.parent = replacement;
      replacement.position.x = 100;
      posed();
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
      const index = new ShadowCasterList();
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
      // The box around every caster, hidden ones too; a removed caster leaves it and the queries.
      upstream.isVisible = false;
      expect(index.queryPlanes(volume)).toEqual([distant]);
      const bounds = index.bounds()!;
      expect([bounds.min.y, bounds.max.y]).toEqual([-0.5, 1000.5]);
      index.remove(upstream);
      expect(index.queryPlanes(volume)).toEqual([distant]);
      expect(index.bounds()!.max.y).toBe(0.5);
      index.remove(distant);
      expect(index.bounds()).toBeUndefined();
      expect(index.queryPlanes(volume)).toEqual([]);
    } finally {
      engine.dispose();
    }
  });
});
