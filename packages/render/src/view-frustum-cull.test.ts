import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cullTaskByVisibilityIndex } from "./view-frustum-cull";
import { VISIBILITY_HEAL_INTERVAL, verifyVisibilityQueries, visibilityDiagnostics } from "./visibility-check";

let engine: NullEngine;
let scene: Scene;
let camera: FreeCamera;
let meshes: Mesh[];
let graph: FrameGraph;

beforeEach(() => {
  engine = new NullEngine({ renderWidth: 320, renderHeight: 180, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  scene = new Scene(engine);
  camera = new FreeCamera("view", new Vector3(0, 6, -40), scene);
  camera.setTarget(Vector3.Zero());
  camera.maxZ = 80;
  let state = 21;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  meshes = Array.from({ length: 120 }, (_, at) => {
    const mesh = CreateBox(`box-${at}`, { width: 0.5 + random() * 10, height: 0.5 + random() * 2, depth: 0.5 + random() * 10 }, scene);
    mesh.position.set((random() - 0.5) * 140, (random() - 0.5) * 20, (random() - 0.5) * 140);
    mesh.cullingStrategy = at % 4;
    mesh.computeWorldMatrix(true);
    return mesh;
  });
  graph = new FrameGraph(scene);
});

afterEach(() => {
  verifyVisibilityQueries(false);
  graph.dispose();
  scene.dispose();
  engine.dispose();
});

/** Babylon's own cull task, recorded; `indexed` has it cull by the visibility index. */
function cullTask(indexed: boolean, list: AbstractMesh[] | null = null): FrameGraphCullObjectsTask {
  const task = new FrameGraphCullObjectsTask(indexed ? "indexed" : "own", graph, scene);
  task.objectList = { meshes: list, particleSystems: null };
  task.camera = camera;
  (graph as unknown as { _currentProcessedTask: unknown })._currentProcessedTask = task;
  task.record();
  (graph as unknown as { _currentProcessedTask: unknown })._currentProcessedTask = null;
  if (indexed) cullTaskByVisibilityIndex(task, scene);
  return task;
}

/** One cull, with the camera's matrices brought up to date first, as the view's cull does before the task runs. */
const run = (task: FrameGraphCullObjectsTask) => {
  camera.getViewMatrix(true);
  camera.getProjectionMatrix(true);
  task._execute();
  return task.outputObjectList.meshes!;
};
const work = () => ({ queries: 0, checks: 0, mismatches: 0, heals: 0, ...visibilityDiagnostics()?.main });

describe("a camera's cull through the visibility index", () => {
  it("lists what Babylon's cull task lists, in its order, for every flag the task reads", () => {
    const own = cullTask(false), indexed = cullTask(true);
    const agree = (label: string) => {
      const expected = [...run(own)];
      expect(run(indexed).map((mesh) => mesh.name), label).toEqual(expected.map((mesh) => mesh.name));
      return expected.length;
    };
    const shown = agree("as built");
    // The view holds some of the boxes and misses others.
    expect(shown).toBeGreaterThan(15);
    expect(shown).toBeLessThan(90);
    const inView = run(own).slice(0, 8) as Mesh[];
    const outOfView = meshes.filter((mesh) => !run(own).includes(mesh)).slice(0, 4);
    const changes: Array<[string, () => void]> = [
      ["disabled", () => inView[0]!.setEnabled(false)],
      ["a disabled parent", () => { inView[2]!.parent = inView[1]!; inView[1]!.setEnabled(false); }],
      ["invisible", () => { inView[3]!.isVisible = false; }],
      ["no visibility", () => { inView[4]!.visibility = 0; }],
      ["another layer", () => { inView[5]!.layerMask = 0x10000000; }],
      ["zero scale", () => { inView[6]!.scaling.y = 0; }],
      ["blocked", () => { (inView[7] as unknown as { _masterMesh: unknown })._masterMesh = inView[0]; }],
      ["always drawn out of view", () => { outOfView[0]!.alwaysSelectAsActiveMesh = true; }],
      ["moved into view", () => { outOfView[1]!.position.set(0, 0, 0); outOfView[1]!.computeWorldMatrix(true); }],
      ["moved out of view", () => { inView[0]!.setEnabled(true); inView[0]!.position.set(0, 0, -400); inView[0]!.computeWorldMatrix(true); }],
      ["the camera turned", () => { camera.setTarget(new Vector3(60, 0, 10)); }],
      ["the camera's layers", () => { camera.layerMask = 0x10000000; }],
      ["frustum clipping off", () => { camera.layerMask = 0x0fffffff; scene.skipFrustumClipping = true; }],
      ["frustum clipping back", () => { scene.skipFrustumClipping = false; }],
    ];
    const counts = changes.map(([label, change]) => {
      change();
      return agree(label);
    });
    // The changes do change the list.
    expect(new Set(counts).size).toBeGreaterThan(4);
    // An explicit input list is culled in its own order.
    const reversed = [...meshes].reverse();
    const ownListed = cullTask(false, reversed), indexedListed = cullTask(true, reversed);
    expect(run(indexedListed)).toEqual([...run(ownListed)]);
    expect(run(indexedListed).length).toBeGreaterThan(0);
  });

  it("keeps the task's frozen list, and makes a new array for each cull as the task does", () => {
    const indexed = cullTask(true);
    const first = run(indexed);
    expect(run(indexed)).not.toBe(first);
    scene._activeMeshesFrozen = true;
    const frozen = indexed.outputObjectList.meshes;
    meshes[0]!.setEnabled(false);
    expect(run(indexed)).toBe(frozen);
    scene._activeMeshesFrozen = false;
  });

  it("uses Babylon's list on every 32nd cull and on every cull while verifying, and finds no difference", () => {
    const indexed = cullTask(true);
    const before = work();
    for (let cull = 0; cull < 2 * VISIBILITY_HEAL_INTERVAL; cull++) {
      meshes[cull]!.position.x += 5;
      meshes[cull]!.computeWorldMatrix(true);
      run(indexed);
    }
    const periodic = work();
    expect([periodic.checks - before.checks, periodic.queries - before.queries]).toEqual([2, 2 * VISIBILITY_HEAL_INTERVAL - 2]);
    verifyVisibilityQueries(true);
    for (let cull = 0; cull < 12; cull++) {
      camera.position.x += 3;
      run(indexed);
    }
    const verified = work();
    expect(verified.checks - periodic.checks).toBe(12);
    expect([verified.mismatches - before.mismatches, verified.heals - before.heals]).toEqual([0, 0]);
  });

  it("counts a difference and uses Babylon's list when a row was written behind the index", () => {
    const own = cullTask(false), indexed = cullTask(true);
    const seen = run(indexed)[0]! as Mesh;
    const info = seen.getBoundingInfo();
    // What the index's contract forbids: world bounds written without `_update`, so the row does not follow.
    info.boundingSphere.centerWorld.set(1e6, 0, 0);
    for (const corner of info.boundingBox.vectorsWorld) corner.set(1e6, 0, 0);
    expect(run(indexed)).toContain(seen);
    const before = work();
    verifyVisibilityQueries(true);
    expect(run(indexed)).toEqual([...run(own)]);
    expect(run(indexed)).not.toContain(seen);
    expect(work().mismatches - before.mismatches).toBe(2);
  });
});
