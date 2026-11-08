import { describe, expect, it } from "vitest";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { CameraShakeView } from "./camera-shake-view";

const ZERO = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, fov: 0 };
const close = (v: Vector3) => v.asArray().map((value) => expect.closeTo(value, 6));

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // Looking along +X under a parent placed away from the origin, as an actor's camera is.
  const rig = new TransformNode("rig", scene);
  rig.position.set(10, 0, 0);
  const camera = new UniversalCamera("camera", new Vector3(0, 2, 0), scene);
  camera.parent = rig;
  camera.rotation.set(0, Math.PI / 2, 0);
  camera.fov = 1;
  const view = new CameraShakeView(scene, () => camera);
  const dispose = () => { view.dispose(); scene.dispose(); engine.dispose(); };
  return { scene, camera, view, dispose };
}

describe("CameraShakeView", () => {
  it("moves along and turns about the camera's own axes for a draw, then restores the pose exactly", () => {
    const { camera, view, dispose } = setup();
    try {
      const right = camera.getDirection(Vector3.Right());
      const position = camera.position.clone();
      const rotation = camera.rotation.clone();
      view.set({ ...ZERO, x: 2, pitch: 20, fov: 10 });
      view.apply();
      expect(camera.position.subtract(position).asArray()).toEqual(close(right.scale(2)));
      // Pitch turns the forward view up or down rather than about the world X axis it faces along.
      const forward = camera.getDirection(Vector3.Forward());
      expect(Math.abs(forward.y)).toBeCloseTo(Math.sin(20 * Math.PI / 180), 6);
      expect(forward.z).toBeCloseTo(0, 6);
      expect(camera.fov).toBeCloseTo(1 + 10 * Math.PI / 180, 9);
      view.apply();
      view.restore();
      expect(camera.position.asArray()).toEqual(position.asArray());
      expect(camera.rotation.asArray()).toEqual(rotation.asArray());
      expect(camera.fov).toBe(1);
      // Without an offset, or after set(null), a draw leaves the camera alone.
      view.set(null);
      view.apply();
      expect(camera.position.asArray()).toEqual(position.asArray());
    } finally {
      dispose();
    }
  });

  it("zooms an orthographic camera about the centre of its bounds and restores them", () => {
    const { camera, view, dispose } = setup();
    try {
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom] = [-4, 6, 3, -3];
      view.set({ ...ZERO, fov: 30 });
      view.apply();
      // A 30° wider view than the 60° reference: tan(45°) / tan(30°) = √3.
      const k = Math.sqrt(3);
      expect([camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom]).toEqual(
        [1 - 5 * k, 1 + 5 * k, 3 * k, -3 * k].map((value) => expect.closeTo(value, 9)));
      view.restore();
      expect([camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom]).toEqual([-4, 6, 3, -3]);
    } finally {
      dispose();
    }
  });

  it("shakes during the scene's draw and stops listening when disposed", () => {
    const { scene, camera, view, dispose } = setup();
    try {
      const seen: number[] = [];
      scene.onBeforeRenderObservable.add(() => seen.push(camera.position.y));
      view.set({ ...ZERO, y: 1 });
      scene.onBeforeRenderObservable.notifyObservers(scene);
      scene.onAfterRenderObservable.notifyObservers(scene);
      expect(seen).toEqual([expect.closeTo(3, 9)]);
      expect(camera.position.y).toBe(2);
      view.dispose();
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(seen.at(-1)).toBe(2);
    } finally {
      dispose();
    }
  });
});
