import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Meshes/instancedMesh";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaneQuery, visibilityIndexCounts } from "./visibility-index";

let engine: NullEngine;
let scene: Scene;
let views: Plane[][];

/** A small seeded generator, so every run builds the same Scene. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

beforeEach(() => {
  engine = new NullEngine({ renderWidth: 320, renderHeight: 180, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  scene = new Scene(engine);
  // Four views of the origin from different sides, each a camera's own six planes.
  views = [[0, 4, -40], [35, 10, 5], [-12, 30, 12], [3, 1, 3]].map(([x, y, z], at) => {
    const camera = new FreeCamera(`view-${at}`, new Vector3(x!, y!, z!), scene);
    camera.setTarget(new Vector3(at * 2, 0, 0));
    camera.maxZ = 90;
    camera.getViewMatrix(true);
    camera.getProjectionMatrix(true);
    const internal = camera as unknown as { _updateFrustumPlanes(): void; _frustumPlanes: Plane[] };
    internal._updateFrustumPlanes();
    return internal._frustumPlanes.map((plane) => plane.clone());
  });
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

/** Boxes of mixed shapes and culling strategies scattered so that each view holds some, cuts some and misses some. */
function scatter(count: number, seed = 1): Mesh[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, at) => {
    const mesh = CreateBox(`box-${seed}-${at}`, { width: 0.2 + random() * 14, height: 0.2 + random() * 3, depth: 0.2 + random() * 14 }, scene);
    mesh.position.set((random() - 0.5) * 120, (random() - 0.5) * 30, (random() - 0.5) * 120);
    mesh.rotation.set(random() * 6, random() * 6, random() * 6);
    mesh.cullingStrategy = at % 4;
    mesh.computeWorldMatrix(true);
    return mesh;
  });
}

/** Every mesh, through every view: the index's answer beside the mesh's own. Returns how many it held, over all views. */
function expectAgreement(meshes: readonly AbstractMesh[], query = new PlaneQuery()): number {
  let held = 0;
  for (const [view, planes] of views.entries()) {
    query.set(planes);
    for (const mesh of meshes) {
      const own = mesh.isInFrustum(planes);
      if (query.holds(mesh) !== own) throw new Error(`${mesh.name} in view ${view}: the index says ${!own}, the mesh ${own}`);
      if (own) held++;
    }
  }
  return held;
}

describe("PlaneQuery against mesh.isInFrustum", () => {
  it("agrees for every culling strategy, with meshes held, cut and missed by each view", () => {
    const meshes = scatter(400);
    const held = expectAgreement(meshes);
    // The comparison is of both answers: each view holds a good share and misses a good share.
    expect(held).toBeGreaterThan(200);
    expect(held).toBeLessThan(meshes.length * views.length - 200);
  });

  it("follows a moved, turned, scaled and re-parented mesh once its world matrix is computed, and not before", () => {
    const meshes = scatter(60, 2);
    const query = new PlaneQuery();
    expectAgreement(meshes, query);
    const parent = new TransformNode("parent", scene);
    const random = seeded(3);
    for (let round = 0; round < 6; round++) {
      for (const [at, mesh] of meshes.entries()) {
        if (at % 3 === 0) mesh.position.set((random() - 0.5) * 120, (random() - 0.5) * 30, (random() - 0.5) * 120);
        if (at % 3 === 1) mesh.scaling.setAll(0.2 + random() * 5);
        if (at % 5 === 0) mesh.parent = round % 2 ? null : parent;
      }
      parent.position.x = round * 7;
      // Written but not computed: the mesh's own test still reads the bounds of its last world matrix, and so must the index.
      expectAgreement(meshes, query);
      // Only some are computed (a child of the moved parent that nothing asked stays where it was for both).
      for (const [at, mesh] of meshes.entries()) if (at % 2) mesh.computeWorldMatrix(true);
      expectAgreement(meshes, query);
      for (const mesh of meshes) mesh.computeWorldMatrix(true);
      expectAgreement(meshes, query);
    }
  });

  it("follows bounds that are replaced, rebuilt in place, scaled, refreshed and marked dirty", () => {
    const meshes = scatter(40, 4);
    const query = new PlaneQuery();
    expectAgreement(meshes, query);
    const [replaced, rebuilt, scaled, refreshed, dirty, encapsulated, centred, thin] = meshes as [Mesh, Mesh, Mesh, Mesh, Mesh, Mesh, Mesh, Mesh];
    replaced.setBoundingInfo(new BoundingInfo(new Vector3(-30, -1, -30), new Vector3(30, 1, 30)));
    expectAgreement(meshes, query);
    replaced.computeWorldMatrix(true);
    expectAgreement(meshes, query);
    rebuilt.getBoundingInfo().reConstruct(new Vector3(-0.01, -0.01, -0.01), new Vector3(0.01, 0.01, 0.01), rebuilt.getWorldMatrix());
    expectAgreement(meshes, query);
    scaled.getBoundingInfo().scale(40);
    expectAgreement(meshes, query);
    refreshed.scaling.setAll(30);
    refreshed.refreshBoundingInfo();
    expectAgreement(meshes, query);
    // Bounds marked dirty are rebuilt by the next `getBoundingInfo`, which both paths call.
    dirty.position.x += 90;
    dirty.computeWorldMatrix(true);
    (dirty as unknown as { _boundingInfoIsDirty: boolean })._boundingInfoIsDirty = true;
    expectAgreement(meshes, query);
    encapsulated.getBoundingInfo().encapsulate(new Vector3(200, 0, 0));
    expectAgreement(meshes, query);
    centred.getBoundingInfo().centerOn(new Vector3(0, 0, 0), new Vector3(60, 60, 60));
    expectAgreement(meshes, query);
    thin.thinInstanceAdd([Matrix.Translation(50, 0, 0), Matrix.Translation(-50, 0, 20)]);
    thin.thinInstanceRefreshBoundingInfo();
    expectAgreement(meshes, query);
  });

  it("follows a frozen world matrix, one frozen by reference and rewritten in place, and an unfrozen one", () => {
    const meshes = scatter(30, 5);
    const query = new PlaneQuery();
    const [frozen, byReference] = meshes as [Mesh, Mesh];
    frozen.freezeWorldMatrix();
    frozen.position.x += 80;
    frozen.computeWorldMatrix();
    expectAgreement(meshes, query);
    const shared = Matrix.Translation(0, 0, 0);
    byReference.freezeWorldMatrix(shared, true);
    expectAgreement(meshes, query);
    // The matrix it holds by reference moves: its bounds follow only when something updates them, for both paths.
    Matrix.TranslationToRef(70, 0, -20, shared);
    expectAgreement(meshes, query);
    byReference.getBoundingInfo().update(shared);
    expectAgreement(meshes, query);
    frozen.unfreezeWorldMatrix();
    frozen.computeWorldMatrix(true);
    expectAgreement(meshes, query);
  });

  it("reads the culling strategy, a regular instance's own bounds and a loading mesh's state on every query", () => {
    const meshes: AbstractMesh[] = scatter(24, 6);
    const query = new PlaneQuery();
    const source = meshes[0] as Mesh;
    for (let at = 0; at < 6; at++) {
      const instance = source.createInstance(`instance-${at}`);
      instance.position.set(at * 20 - 50, 0, at * 9 - 20);
      instance.computeWorldMatrix(true);
      meshes.push(instance);
    }
    expectAgreement(meshes, query);
    for (let strategy = 0; strategy < 4; strategy++) {
      for (const mesh of meshes) mesh.cullingStrategy = strategy;
      expectAgreement(meshes, query);
    }
    // A mesh that is loading is in no view, and one whose bounds pass has its delay state checked, once per test.
    const loading = meshes[1] as Mesh;
    loading.delayLoadState = 2;
    for (const planes of views) expect(query.set(planes).holds(loading)).toBe(false);
    loading.delayLoadState = 0;
    const near = CreateBox("near", { size: 1 }, scene);
    near.computeWorldMatrix(true);
    const checked = vi.spyOn(near, "_checkDelayState");
    const own = views.map((planes) => near.isInFrustum(planes));
    const ownChecks = checked.mock.calls.length;
    checked.mockClear();
    expect(views.map((planes) => query.set(planes).holds(near))).toEqual(own);
    expect(checked.mock.calls.length).toBe(ownChecks);
    expect(ownChecks).toBeGreaterThan(0);
  });

  it("asks a mesh or bounds with a test of its own the old way", () => {
    const [custom, plain] = scatter(2, 7) as [Mesh, Mesh];
    const query = new PlaneQuery();
    custom.isInFrustum = () => false;
    class OpenBounds extends BoundingInfo {
      override isInFrustum(): boolean { return true; }
    }
    plain.position.set(500, 500, 500);
    plain.computeWorldMatrix(true);
    plain.setBoundingInfo(new OpenBounds(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)));
    const before = visibilityIndexCounts().deferred;
    for (const planes of views) {
      query.set(planes);
      expect(query.holds(custom)).toBe(false);
      expect(query.holds(plain)).toBe(true);
    }
    expect(visibilityIndexCounts().deferred - before).toBe(views.length * 2);
  });

  it("reads a mesh's bounds once, and again only after they changed", () => {
    const meshes = scatter(50, 8);
    const query = new PlaneQuery();
    const reads = () => visibilityIndexCounts().rowReads;
    const start = reads();
    expectAgreement(meshes, query);
    expect(reads() - start).toBe(50);
    for (let frame = 0; frame < 10; frame++) expectAgreement(meshes, query);
    // Another view's query shares the rows.
    expectAgreement(meshes, new PlaneQuery());
    expect(reads() - start).toBe(50);
    for (const mesh of meshes.slice(0, 7)) {
      mesh.position.y += 1;
      mesh.computeWorldMatrix(true);
    }
    // An unforced compute of a mesh that did not move changes nothing.
    for (const mesh of meshes) mesh.computeWorldMatrix();
    expectAgreement(meshes, query);
    expect(reads() - start).toBe(57);
  });
});
