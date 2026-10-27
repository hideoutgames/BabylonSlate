import { afterEach, expect, it } from "vitest";
import { Mesh, MeshBuilder, Matrix, NullEngine, Scene, ScenePerformancePriority, Skeleton } from "@babylonjs/core";
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
  // Intermediate marks every mesh it constructs; the next cull settles them.
  expect([plain, emitter, particles, thin, skinned].every((mesh) => mesh.alwaysSelectAsActiveMesh)).toBe(true);
  settlePlayViewCulling(scene);
  expect(Object.fromEntries([plain, emitter, particles, thin, skinned].map((mesh) => [mesh.name, mesh.alwaysSelectAsActiveMesh])))
    .toEqual({ plain: false, emitter: true, particles: true, thin: true, skinned: true });
});
