import { afterEach, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { cullSceneByBoxes } from "./cull-accuracy";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { SceneRenderCoordinator } from "./scene-render-coordinator";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function fixture() {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  // Looks along +z from the origin: at z = 10 its view ends near x = 8.5.
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  camera.setTarget(new Vector3(0, 0, 1));
  const planes = Frustum.GetPlanes(camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true)));
  const at = (name: string, x: number, size: { width: number; height: number }): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, { ...size, depth: 0.2 }, scene);
    mesh.position.set(x, 0, 10);
    mesh.computeWorldMatrix(true);
    return mesh;
  };
  const seen = (...meshes: Mesh[]) => Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh.isInFrustum(planes)]));
  return { scene, at, seen };
}

/** Babylon announces a new mesh on a later task. */
const announced = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("culls a long mesh by its box where its sphere alone would keep it, and a mesh added later too", async () => {
  const { scene, at, seen } = fixture();
  // A beam 40 tall, beside the view: nothing of it is inside, but the sphere around it reaches far in.
  const beam = at("beam", 14, { width: 0.2, height: 40 });
  expect(seen(beam)).toEqual({ beam: true });
  // A mesh the Scene has already announced takes the strategy too.
  await announced();
  cullSceneByBoxes(scene);
  expect(seen(beam)).toEqual({ beam: false });
  const later = at("later", -14, { width: 0.2, height: 40 });
  // What the view does show stays: a mesh in front, and one whose box crosses the view's edge.
  const ahead = at("ahead", 0, { width: 1, height: 1 });
  const crossing = at("crossing", 11, { width: 8, height: 1 });
  await announced();
  expect(seen(beam, later, ahead, crossing)).toEqual({ beam: false, later: false, ahead: true, crossing: true });
  // Asking again adds no second observer.
  const observers = scene.onNewMeshAddedObservable.observers.length;
  cullSceneByBoxes(scene);
  expect(scene.onNewMeshAddedObservable.observers.length).toBe(observers);
});

it("is how every Scene a view draws culls", async () => {
  const { scene, at, seen } = fixture();
  const view = new SceneRenderCoordinator(scene);
  disposers.push(() => view.dispose());
  const beam = at("beam", 14, { width: 0.2, height: 40 });
  await announced();
  expect(seen(beam)).toEqual({ beam: false });
});
