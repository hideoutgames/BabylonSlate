import { describe, expect, it } from "vitest";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { deprojectViewRay, type CursorRay, type DrawnCameraView } from "@haptic/core";
import { CameraShakeView } from "./camera-shake-view";
import { captureDrawnCameraView, DrawnCameraViewReporter } from "./drawn-camera-view";
import { applyAuthoredCameraLens } from "./scene-illumination";

/** A 400 x 200 view whose camera rides a turned, raised parent, as a camera on an actor's Spring Arm socket does. */
function setup() {
  const engine = new NullEngine({ renderWidth: 400, renderHeight: 200, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  const socket = new TransformNode("socket", scene);
  socket.position.set(3, 4, -9);
  socket.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.4, 0.3, 0.1);
  const camera = new UniversalCamera("camera", new Vector3(0.5, -0.25, 1), scene);
  camera.parent = socket;
  camera.rotationQuaternion = Quaternion.RotationYawPitchRoll(-0.2, 0.15, 0);
  camera.minZ = 0.1;
  camera.maxZ = 200;
  scene.activeCamera = camera;
  return { engine, scene, camera, dispose: () => { scene.dispose(); engine.dispose(); } };
}

/** Where Babylon draws `point` on the 400 x 200 canvas, from the top-left corner. */
function screenOf(camera: Camera, point: Vector3): Vector3 {
  const transform = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
  return Vector3.Project(point, Matrix.Identity(), transform, camera.viewport.toGlobal(400, 200));
}

/** How far `ray` passes from `point`. */
function miss(ray: CursorRay, point: Vector3): number {
  const v = point.subtract(new Vector3(ray.origin.x, ray.origin.y, ray.origin.z));
  const d = new Vector3(ray.direction.x, ray.direction.y, ray.direction.z);
  return v.subtract(d.scale(Vector3.Dot(v, d))).length();
}

const POINTS = [new Vector3(2, 1, 6), new Vector3(-1.5, 3.5, 4), new Vector3(6, 0, 12)];

/** Every point Babylon draws on screen deprojects to a ray through that point, in front of the camera. */
function expectRaysThroughDrawnPoints(camera: Camera, view: DrawnCameraView) {
  for (const point of POINTS) {
    const local = Vector3.TransformCoordinates(point, camera.getViewMatrix());
    if (local.z <= camera.minZ) continue;
    const screen = screenOf(camera, point);
    const ray = deprojectViewRay({ x: screen.x, y: screen.y }, { width: 400, height: 200 }, view);
    expect(miss(ray, point)).toBeLessThan(1e-6);
    const toPoint = point.subtract(new Vector3(ray.origin.x, ray.origin.y, ray.origin.z));
    expect(Vector3.Dot(toPoint, new Vector3(ray.direction.x, ray.direction.y, ray.direction.z))).toBeGreaterThan(0);
  }
}

describe("captureDrawnCameraView", () => {
  it("deprojects what a perspective camera under a parent draws, whatever authored aspect and lens extent framed it", () => {
    const { camera, dispose } = setup();
    try {
      // A 1.3 render aspect on a 2:1 canvas, widened by a lens extent: nothing the canvas size alone would give.
      applyAuthoredCameraLens(camera, { projectionMode: "perspective", fieldOfView: 55, nearClip: 0.1, farClip: 200 }, 1.3, 1.25);
      expectRaysThroughDrawnPoints(camera, captureDrawnCameraView(camera, 4));
    } finally { dispose(); }
  });

  it("deprojects what an orthographic camera with off-centre bounds draws", () => {
    const { camera, dispose } = setup();
    try {
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -7;
      camera.orthoRight = 5;
      camera.orthoTop = 4;
      camera.orthoBottom = -2;
      const view = captureDrawnCameraView(camera, 4);
      expect(view.projection).toBe("orthographic");
      expectRaysThroughDrawnPoints(camera, view);
    } finally { dispose(); }
  });

  it("captures a draw's Camera Shake, which is gone again after the draw", () => {
    const { scene, camera, dispose } = setup();
    try {
      const shake = new CameraShakeView(scene, () => camera);
      shake.set({ x: 0.4, y: -0.2, z: 0.1, pitch: 4, yaw: -3, roll: 2, fov: 6 });
      shake.apply();
      const shaken = captureDrawnCameraView(camera, 4);
      expectRaysThroughDrawnPoints(camera, shaken);
      shake.restore();
      const steady = captureDrawnCameraView(camera, 4);
      expect(steady.position).not.toEqual(shaken.position);
      expect(steady.scaleY).not.toBeCloseTo(shaken.scaleY, 6);
      shake.dispose();
    } finally { dispose(); }
  });
});

describe("DrawnCameraViewReporter", () => {
  it("reports a view once, and again only when the camera, its lens or the possessed slot changes", () => {
    const { camera, dispose } = setup();
    try {
      const reports: DrawnCameraView[] = [];
      const reporter = new DrawnCameraViewReporter((view) => reports.push(view));
      reporter.update(camera, 4);
      reporter.update(camera, 4);
      expect(reports).toHaveLength(1);
      camera.position.x += 0.5;
      reporter.update(camera, 4);
      camera.fov = 1.1;
      reporter.update(camera, 4);
      reporter.update(camera, 9);
      expect(reports.map((view) => view.slotId)).toEqual([4, 4, 4, 9]);
      expect(reports[1]!.position).not.toEqual(reports[0]!.position);
      // The projection matrix holds float32 values.
      expect(reports[2]!.scaleY).toBeCloseTo(1 / Math.tan(0.55), 6);
    } finally { dispose(); }
  });
});
