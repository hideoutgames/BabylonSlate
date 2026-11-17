import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPlanarMirrorMeshes } from "./planar-mirror";
import { VISIBILITY_HEAL_INTERVAL, verifyVisibilityQueries, visibilityDiagnostics } from "./visibility-check";

let engine: NullEngine;
let scene: Scene;
let planes: Plane[];
let meshes: Mesh[];

beforeEach(() => {
  engine = new NullEngine({ renderWidth: 320, renderHeight: 180, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  scene = new Scene(engine);
  const camera = new FreeCamera("view", new Vector3(0, 6, -40), scene);
  camera.setTarget(Vector3.Zero());
  camera.maxZ = 80;
  camera.getViewMatrix(true);
  camera.getProjectionMatrix(true);
  const internal = camera as unknown as { _updateFrustumPlanes(): void; _frustumPlanes: Plane[] };
  internal._updateFrustumPlanes();
  planes = internal._frustumPlanes.map((plane) => plane.clone());
  let state = 11;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  meshes = Array.from({ length: 80 }, (_, at) => {
    const mesh = CreateBox(`box-${at}`, { width: 0.5 + random() * 10, height: 0.5 + random() * 2, depth: 0.5 + random() * 10 }, scene);
    mesh.position.set((random() - 0.5) * 140, (random() - 0.5) * 20, (random() - 0.5) * 140);
    mesh.cullingStrategy = 2;
    return mesh;
  });
  // Some follow the camera or are always drawn: listed whatever the planes.
  meshes[3]!.infiniteDistance = true;
  meshes[4]!.alwaysSelectAsActiveMesh = true;
  meshes[5]!.setEnabled(false);
  meshes[6]!.isVisible = false;
});

afterEach(() => {
  verifyVisibilityQueries(false);
  scene.dispose();
  engine.dispose();
});

/** The list as each mesh answers for itself: the rule the collected list must reproduce, in Scene order. */
function ownList(): AbstractMesh[] {
  return scene.meshes.filter((mesh) => {
    if (!mesh.isEnabled() || !mesh.isVisible) return false;
    if (mesh.infiniteDistance || mesh.alwaysSelectAsActiveMesh) return true;
    mesh.computeWorldMatrix();
    return mesh.isInFrustum(planes);
  });
}

/** One frame's list: an unforced world matrix is computed once per render id, so each frame takes a new one. */
const collect = () => {
  scene.incrementRenderId();
  const list: AbstractMesh[] = [];
  collectPlanarMirrorMeshes(scene, list, 0x0fffffff, planes, () => false, false);
  return list;
};
const work = () => ({ queries: 0, checks: 0, mismatches: 0, heals: 0, ...visibilityDiagnostics()?.mirror });

describe("a planar reflection's list culled by the visibility index", () => {
  it("lists what each mesh's own test lists, in Scene order, as meshes move and their bounds change", () => {
    const first = collect();
    expect(first).toEqual(ownList());
    // The view holds some of the boxes and misses others.
    expect(first.length).toBeGreaterThan(8);
    expect(first.length).toBeLessThan(60);
    for (let frame = 0; frame < 3 * VISIBILITY_HEAL_INTERVAL; frame++) {
      const moved = meshes[(frame * 7) % meshes.length]!;
      moved.position.x = ((frame * 37) % 140) - 70;
      if (frame % 5 === 0) meshes[(frame * 3) % meshes.length]!.getBoundingInfo().scale(frame % 2 ? 4 : 0.25);
      if (frame % 9 === 0) meshes[10]!.setEnabled(frame % 2 === 0);
      expect(collect(), `frame ${frame}`).toEqual(ownList());
    }
  });

  it("checks every 32nd list against the meshes' own tests, every list while verifying, and finds no difference", () => {
    const before = work();
    for (let list = 0; list < 2 * VISIBILITY_HEAL_INTERVAL; list++) collect();
    const periodic = work();
    expect([periodic.checks - before.checks, periodic.queries - before.queries]).toEqual([2, 2 * VISIBILITY_HEAL_INTERVAL - 2]);
    verifyVisibilityQueries(true);
    for (let list = 0; list < 10; list++) {
      meshes[list]!.position.z += 3;
      collect();
    }
    const verified = work();
    expect(verified.checks - periodic.checks).toBe(10);
    expect([verified.mismatches - before.mismatches, verified.heals - before.heals]).toEqual([0, 0]);
  });

  it("uses the meshes' own answers on a check, and counts the difference, when a row was written behind the index", () => {
    collect();
    // A corner and centre moved far away without `_update`: what the index's contract forbids. Its row is now stale.
    const seen = collect()[0]! as Mesh;
    const info = seen.getBoundingInfo();
    info.boundingSphere.centerWorld.set(1e6, 0, 0);
    for (const corner of info.boundingBox.vectorsWorld) corner.set(1e6, 0, 0);
    expect(seen.isInFrustum(planes)).toBe(false);
    const before = work();
    verifyVisibilityQueries(true);
    const healed = collect();
    expect(healed).toEqual(ownList());
    expect(healed).not.toContain(seen);
    expect(work().mismatches - before.mismatches).toBe(1);
  });
});
