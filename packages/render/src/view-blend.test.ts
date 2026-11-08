import { describe, expect, it } from "vitest";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { captureView, ViewBlend } from "./view-blend";

function viewMatrix(camera: Camera): number[] {
  return Array.from(camera.getViewMatrix(true).asArray());
}

describe("ViewBlend", () => {
  it.each([false, true])("eases from the start view to the target's live view (right-handed %s)", (rightHanded) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = rightHanded;
    try {
      const from = new UniversalCamera("from", new Vector3(0, 2, -10), scene);
      from.setTarget(new Vector3(0, 0, 0));
      from.fov = 0.8;
      // The target hangs from a moving parent, as an actor's camera does.
      const rig = new TransformNode("rig", scene);
      rig.position.set(20, 0, 0);
      const to = new UniversalCamera("to", new Vector3(0, 5, 0), scene);
      to.parent = rig;
      to.setTarget(new Vector3(0, 0, 10));
      to.fov = 1.2;
      scene.activeCamera = from;

      const blend = new ViewBlend(scene, captureView(from), 2, "linear");
      scene.activeCamera = blend.camera;
      expect(blend.update(0, to)).toBe(true);
      expect(viewMatrix(blend.camera).map((value, index) => value - viewMatrix(from)[index]!).every((d) => Math.abs(d) < 1e-6)).toBe(true);

      expect(blend.update(1, to)).toBe(true);
      const start = from.globalPosition, end = to.globalPosition;
      expect(blend.camera.position.asArray()).toEqual(Vector3.Lerp(start, end, 0.5).asArray().map((value) => expect.closeTo(value, 6)));
      expect(blend.camera.fov).toBeCloseTo(1, 9);

      // The target moves on during the blend; just before the end the view is the target's.
      rig.position.set(30, 0, 0);
      expect(blend.update(0.999999, to)).toBe(true);
      expect(viewMatrix(blend.camera).map((value, index) => value - viewMatrix(to)[index]!).every((d) => Math.abs(d) < 1e-4)).toBe(true);
      expect(blend.update(0.01, to)).toBe(false);
      blend.dispose();
      expect(scene.activeCamera).toBeNull();
      expect(blend.camera.isDisposed()).toBe(true);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("ends when another camera takes the view, the target is gone or its projection differs", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const from = new UniversalCamera("from", new Vector3(0, 0, -5), scene);
      const to = new UniversalCamera("to", new Vector3(5, 0, 0), scene);
      const blend = new ViewBlend(scene, captureView(from), 1, "linear");
      expect(blend.update(0.1, to)).toBe(false);
      scene.activeCamera = blend.camera;
      expect(blend.update(0.1, null)).toBe(false);
      to.mode = Camera.ORTHOGRAPHIC_CAMERA;
      expect(blend.update(0.1, to)).toBe(false);
      to.mode = Camera.PERSPECTIVE_CAMERA;
      expect(blend.update(0.1, to)).toBe(true);
      scene.activeCamera = from;
      expect(blend.update(0.1, to)).toBe(false);
      blend.dispose();
      expect(scene.activeCamera).toBe(from);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
