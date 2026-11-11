import { afterEach, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { cullSceneByWhatShows } from "./cull-accuracy";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { skinnedRig, skinnedStrip } from "./skinned-test-fixtures";

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
  cullSceneByWhatShows(scene);
  expect(seen(beam)).toEqual({ beam: false });
  const later = at("later", -14, { width: 0.2, height: 40 });
  // What the view does show stays: a mesh in front, and one whose box crosses the view's edge.
  const ahead = at("ahead", 0, { width: 1, height: 1 });
  const crossing = at("crossing", 11, { width: 8, height: 1 });
  await announced();
  expect(seen(beam, later, ahead, crossing)).toEqual({ beam: false, later: false, ahead: true, crossing: true });
  // Asking again adds no second observer.
  const observers = scene.onNewMeshAddedObservable.observers.length;
  cullSceneByWhatShows(scene);
  expect(scene.onNewMeshAddedObservable.observers.length).toBe(observers);
});

it("culls a skinned mesh by where its skeleton poses it, not by where it was authored", async () => {
  const { scene, seen } = fixture();
  const engine = scene.getEngine();
  /** A frame's before-render work, where the bounds take the frame's pose. */
  const frame = () => {
    engine.beginFrame();
    scene.onBeforeRenderObservable.notifyObservers(scene);
    engine.endFrame();
  };
  const here = skinnedRig(scene), away = skinnedRig(scene);
  // Stands far beside the view, and is posed into it: its skeleton's root carries it back thirty units.
  const reaching = skinnedStrip(scene, here.skeleton, "reaching");
  reaching.position.set(30, 0, 10);
  // Stands in the view, and is posed out of it.
  const leaving = skinnedStrip(scene, away.skeleton, "leaving");
  leaving.position.set(0, 0, 10);
  for (const mesh of [reaching, leaving]) mesh.computeWorldMatrix(true);
  await announced();
  cullSceneByWhatShows(scene);
  // Bounds follow both: neither is marked drawn whatever the view.
  expect([reaching.alwaysSelectAsActiveMesh, leaving.alwaysSelectAsActiveMesh]).toEqual([false, false]);
  // As authored, each is where it stands.
  frame();
  expect(seen(reaching, leaving)).toEqual({ reaching: false, leaving: true });
  here.root.position = new Vector3(-30, 0, 0);
  away.root.position = new Vector3(30, 0, 0);
  // Until the frame's before-render work, the cull still has the last frame's pose.
  expect(seen(reaching, leaving)).toEqual({ reaching: false, leaving: true });
  frame();
  expect(seen(reaching, leaving)).toEqual({ reaching: true, leaving: false });
});

it("never culls a mesh a pose moves on the GPU, whose bounds do not follow the pose", async () => {
  const { scene, at } = fixture();
  const skinned = at("skinned", 14, { width: 1, height: 1 });
  skinned.skeleton = new Skeleton("skeleton", "skeleton", scene);
  const morphed = at("morphed", 14, { width: 1, height: 1 });
  morphed.morphTargetManager = new MorphTargetManager(scene);
  const plain = at("plain", 14, { width: 1, height: 1 });
  const drawn = (...meshes: AbstractMesh[]) => Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh.alwaysSelectAsActiveMesh]));
  await announced();
  cullSceneByWhatShows(scene);
  expect(drawn(skinned, morphed, plain)).toEqual({ skinned: true, morphed: true, plain: false });
  // One added later, and an instance, which draws its source's posed vertices.
  const later = at("later", 14, { width: 1, height: 1 });
  later.skeleton = skinned.skeleton;
  const copy = skinned.createInstance("copy"), plainCopy = plain.createInstance("plain copy");
  await announced();
  expect(drawn(later, copy, plainCopy)).toEqual({ later: true, copy: true, "plain copy": false });
});

it("is how every Scene a view draws culls", async () => {
  const { scene, at, seen } = fixture();
  const view = new SceneRenderCoordinator(scene);
  disposers.push(() => view.dispose());
  const beam = at("beam", 14, { width: 0.2, height: 40 });
  await announced();
  expect(seen(beam)).toEqual({ beam: false });
});
