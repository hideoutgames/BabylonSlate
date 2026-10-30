import { afterEach, expect, it } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { scopePreviousWorldMatricesToVelocity } from "./velocity-previous-matrices";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  const source = MeshBuilder.CreateBox("source", {}, scene);
  source.material = new StandardMaterial("surface", scene);
  source.isVisible = false;
  const instance = source.createInstance("mover");
  const velocity = new ObjectRenderer("velocity", scene);
  // A frame graph with a velocity task requires previous world matrices for the whole graph.
  scene.needsPreviousWorldMatrices = true;
  /** A draw of the Scene's instanced batch inside the velocity renderer's rendering-manager render. */
  const velocityDraw = () => {
    velocity.onBeforeRenderingManagerRenderObservable.notifyObservers(0);
    try { scene.render(); } finally { velocity.onAfterRenderingManagerRenderObservable.notifyObservers(0); }
  };
  const previousX = () => instance._previousWorldMatrix?.getTranslation().x;
  return { scene, instance, velocity, velocityDraw, previousX };
}

it("advances a moving instance's previous world matrix only in velocity draws, not in the passes drawn before them", async () => {
  const { scene, instance, velocity, velocityDraw, previousX } = fixture();
  await scene.whenReadyAsync();
  scopePreviousWorldMatricesToVelocity(scene, velocity);
  velocityDraw();
  expect(previousX()).toBe(0);
  // It moves; a shadow map and the colour pass draw it before the frame's geometry pass.
  instance.position.x = 1;
  scene.render();
  scene.render();
  expect(previousX()).toBe(0);
  // The geometry pass writes last frame's matrix as previous, then advances it.
  velocityDraw();
  expect(previousX()).toBe(1);
});

it("answers the flag as Babylon would once the scope is released", async () => {
  const { scene, velocity, previousX, instance } = fixture();
  await scene.whenReadyAsync();
  const release = scopePreviousWorldMatricesToVelocity(scene, velocity);
  expect(scene.needsPreviousWorldMatrices).toBe(false);
  release();
  expect(scene.needsPreviousWorldMatrices).toBe(true);
  scene.render();
  instance.position.x = 2;
  scene.render();
  expect(previousX()).toBe(2);
});
