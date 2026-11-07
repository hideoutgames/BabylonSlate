import { afterEach, expect, it } from "vitest";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
// Registers thin instances, which the fixture adds.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { drawWhateverTheView, installPlayViewCulling, settlePlayViewCulling } from "./play-view-culling";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

it("culls Play's meshes by view, except those whose bounds do not hold or that the engine always draws", () => {
  const engine = new NullEngine();
  engines.push(engine);
  // NullEngine reports no instanced arrays, which thin instances need.
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  scene.performancePriority = ScenePerformancePriority.Intermediate;
  installPlayViewCulling(scene);
  const plain = MeshBuilder.CreateBox("plain", {}, scene);
  const emitter = new Mesh("emitter", scene);
  const particles = MeshBuilder.CreateBox("particles", {}, scene);
  drawWhateverTheView(particles);
  const thin = MeshBuilder.CreateBox("thin", {}, scene);
  thin.thinInstanceAdd(Matrix.Translation(10, 0, 0));
  const skinned = MeshBuilder.CreateBox("skinned", {}, scene);
  skinned.skeleton = new Skeleton("skeleton", "skeleton", scene);
  // A glTF node instance: a regular instance draws its source's geometry through its own world matrix.
  const instance = plain.createInstance("instance");
  const skinnedInstance = skinned.createInstance("skinned instance");
  const meshes = [plain, emitter, particles, thin, skinned, instance, skinnedInstance];
  // Intermediate marks every mesh it constructs; the next cull settles them.
  expect(meshes.every((mesh) => mesh.alwaysSelectAsActiveMesh)).toBe(true);
  settlePlayViewCulling(scene);
  expect(Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh.alwaysSelectAsActiveMesh]))).toEqual({
    plain: false, emitter: true, particles: true, thin: true, skinned: true, instance: false, "skinned instance": true,
  });
});
