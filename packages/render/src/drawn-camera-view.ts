import { Camera } from "@babylonjs/core/Cameras/camera";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { DrawnCameraView } from "@haptic/core";

const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();

/**
 * The view `camera` draws through now, as `DrawnCameraView` describes it: the pose of its world matrix (the inverse of
 * its view matrix, so a parent, a Camera Shake or a view blend applied to it counts) and the terms of the projection
 * matrix it renders with (whatever aspect, lens extent or field of view produced it).
 */
export function captureDrawnCameraView(camera: Camera, slotId: number): DrawnCameraView {
  camera.getWorldMatrix().decompose(scratchScale, scratchRotation, scratchPosition);
  const m = camera.getProjectionMatrix().m;
  const orthographic = camera.mode === Camera.ORTHOGRAPHIC_CAMERA;
  return {
    slotId,
    position: { x: scratchPosition.x, y: scratchPosition.y, z: scratchPosition.z },
    rotation: { x: scratchRotation.x, y: scratchRotation.y, z: scratchRotation.z, w: scratchRotation.w },
    projection: orthographic ? "orthographic" : "perspective",
    scaleX: m[0]!,
    scaleY: m[5]!,
    // A perspective matrix offsets by depth (row 2); an orthographic one by a constant (row 3).
    offsetX: orthographic ? m[12]! : m[8]!,
    offsetY: orthographic ? m[13]! : m[9]!,
    near: camera.minZ,
    far: camera.maxZ,
  };
}

function sameView(a: DrawnCameraView, b: DrawnCameraView): boolean {
  return a.slotId === b.slotId && a.projection === b.projection &&
    a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z &&
    a.rotation.x === b.rotation.x && a.rotation.y === b.rotation.y && a.rotation.z === b.rotation.z && a.rotation.w === b.rotation.w &&
    a.scaleX === b.scaleX && a.scaleY === b.scaleY && a.offsetX === b.offsetX && a.offsetY === b.offsetY &&
    a.near === b.near && a.far === b.far;
}

/**
 * Reports the view Play's world draws through a possessed camera to the game (`onGameView`), once per change: a still
 * camera sends nothing after its first draw.
 */
export class DrawnCameraViewReporter {
  private last: DrawnCameraView | null = null;
  private readonly report: (view: DrawnCameraView) => void;

  constructor(report: (view: DrawnCameraView) => void) {
    this.report = report;
  }

  /** Call as a world draw begins, after everything that moves its camera for that draw. */
  update(camera: Camera, slotId: number): void {
    const view = captureDrawnCameraView(camera, slotId);
    if (this.last && sameView(this.last, view)) return;
    this.last = view;
    this.report(view);
  }
}
