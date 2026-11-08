import type { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { sampleEasingCurve, type EasingCurve } from "@haptic/core";

/** The temporary camera a Possess Camera With Blend views through until the blend ends. */
export const VIEW_BLEND_CAMERA_NAME = "playViewBlend";

/** A camera's world pose and lens at one moment. */
export type ViewPose = {
  position: Vector3;
  rotation: Quaternion;
  mode: number;
  fov: number;
  ortho: [left: number, right: number, top: number, bottom: number];
};

/** `camera`'s current world pose (from its world matrix, so a parented camera counts its parents) and lens. */
export function captureView(camera: Camera): ViewPose {
  const position = new Vector3();
  const rotation = new Quaternion();
  camera.computeWorldMatrix().decompose(new Vector3(), rotation, position);
  return {
    position,
    rotation,
    mode: camera.mode,
    fov: camera.fov,
    ortho: [camera.orthoLeft ?? 0, camera.orthoRight ?? 0, camera.orthoTop ?? 0, camera.orthoBottom ?? 0],
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Possess Camera With Blend: a camera of its own that eases from the view as it was when the blend began to the
 * target camera's live view, then hands the view back. The owner makes it the active camera, calls `update` each
 * frame with the current game camera, and ends the blend when `update` returns false.
 */
export class ViewBlend {
  readonly camera: UniversalCamera;
  private readonly scene: Scene;
  private readonly from: ViewPose;
  private readonly seconds: number;
  private readonly curve: EasingCurve;
  private elapsed = 0;

  constructor(scene: Scene, from: ViewPose, seconds: number, curve: EasingCurve) {
    this.scene = scene;
    this.from = from;
    this.seconds = seconds;
    this.curve = curve;
    this.camera = new UniversalCamera(VIEW_BLEND_CAMERA_NAME, from.position.clone(), scene);
    this.camera.rotationQuaternion = from.rotation.clone();
    this.camera.inputs.clear();
  }

  /**
   * Moves the blend on by `dtSeconds` toward `to`. False when it is over: its time is up, there is no target, the
   * target's projection differs from the start's, or something else took the view.
   */
  update(dtSeconds: number, to: Camera | null): boolean {
    if (!to || to === this.camera || this.scene.activeCamera !== this.camera || to.mode !== this.from.mode) return false;
    this.elapsed += Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
    if (this.elapsed >= this.seconds) return false;
    const t = sampleEasingCurve(this.curve, this.elapsed / this.seconds);
    const target = captureView(to);
    const camera = this.camera;
    Vector3.LerpToRef(this.from.position, target.position, t, camera.position);
    Quaternion.SlerpToRef(this.from.rotation, target.rotation, t, camera.rotationQuaternion!);
    camera.mode = to.mode;
    camera.fov = lerp(this.from.fov, target.fov, t);
    camera.fovMode = to.fovMode;
    [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom] =
      this.from.ortho.map((value, index) => lerp(value, target.ortho[index]!, t)) as ViewPose["ortho"];
    camera.minZ = to.minZ;
    camera.maxZ = to.maxZ;
    camera.layerMask = to.layerMask;
    camera.viewport = to.viewport;
    return true;
  }

  /** Releases the blend camera, leaving no active camera when it was the active one. */
  dispose(): void {
    if (this.scene.activeCamera === this.camera) this.scene.activeCamera = null;
    this.camera.dispose();
  }
}
