import { Camera } from "@babylonjs/core/Cameras/camera";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

/** A view's shake: offset in its own axes (X right, Y up, Z forward), rotation and Field Of View in degrees. */
export interface CameraShakeViewOffset {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
  fov: number;
}

const DEGREES = Math.PI / 180;
/** An orthographic view zooms as much as a Field Of View change would widen a view of this angle. */
const ORTHO_REFERENCE_FOV = 60 * DEGREES;
const MIN_FOV = 1 * DEGREES;
const MAX_FOV = 179 * DEGREES;

type Saved = {
  camera: TargetCamera;
  position: Vector3;
  rotationQuaternion: Quaternion | null;
  rotation: Vector3;
  fov: number;
  ortho: [number | null, number | null, number | null, number | null];
};

const scratchQuaternion = new Quaternion();
const scratchShake = new Quaternion();
const scratchOffset = new Vector3();

/**
 * Shakes a scene's rendering camera without owning its pose: before each draw (`onBeforeRenderObservable`) it
 * moves and turns the camera by the offset in the camera's own axes and widens its view, and after the draw
 * (`onAfterRenderObservable`) it puts back exactly what it changed, so snapshots, blends and scripts keep writing
 * the unshaken pose. Location moves the camera's local position by its local rotation (a parent's scale is not
 * applied); rotation turns it in its own frame. An orthographic camera zooms its bounds about their centre.
 */
export class CameraShakeView {
  private offset: CameraShakeViewOffset | null = null;
  private saved: Saved | null = null;
  private readonly scene: Scene;
  private readonly camera: () => Camera | null;
  private readonly before: Observer<Scene>;
  private readonly after: Observer<Scene>;

  /** `camera` names the camera each draw renders through; a camera it returns that is not a target camera is left alone. */
  constructor(scene: Scene, camera: () => Camera | null) {
    this.scene = scene;
    this.camera = camera;
    this.before = scene.onBeforeRenderObservable.add(() => this.apply());
    this.after = scene.onAfterRenderObservable.add(() => this.restore());
  }

  /** The offset the next draws use; null leaves the camera unshaken. */
  set(offset: CameraShakeViewOffset | null): void {
    this.offset = offset && Object.values(offset).every(Number.isFinite) ? { ...offset } : null;
  }

  get active(): boolean {
    return this.offset !== null;
  }

  /** Shakes the camera for one draw; a second call before `restore` changes nothing. */
  apply(): void {
    const offset = this.offset;
    if (!offset || this.saved) return;
    const camera = this.camera();
    if (!(camera instanceof TargetCamera) || camera.isDisposed()) return;
    this.saved = {
      camera,
      position: camera.position.clone(),
      rotationQuaternion: camera.rotationQuaternion ? camera.rotationQuaternion.clone() : null,
      rotation: camera.rotation.clone(),
      fov: camera.fov,
      ortho: [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom],
    };
    const local = camera.rotationQuaternion
      ? scratchQuaternion.copyFrom(camera.rotationQuaternion)
      : Quaternion.FromEulerAnglesToRef(camera.rotation.x, camera.rotation.y, camera.rotation.z, scratchQuaternion);
    scratchOffset.set(offset.x, offset.y, offset.z).rotateByQuaternionToRef(local, scratchOffset);
    camera.position.addInPlace(scratchOffset);
    Quaternion.RotationYawPitchRollToRef(offset.yaw * DEGREES, offset.pitch * DEGREES, offset.roll * DEGREES, scratchShake);
    // The shake turns the camera in its own frame: after its rotation.
    const shaken = local.multiply(scratchShake);
    if (camera.rotationQuaternion) camera.rotationQuaternion.copyFrom(shaken);
    else shaken.toEulerAnglesToRef(camera.rotation);
    if (offset.fov !== 0) {
      if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) this.zoomOrtho(camera, offset.fov);
      else camera.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, camera.fov + offset.fov * DEGREES));
    }
  }

  /** Puts back what `apply` changed. */
  restore(): void {
    const saved = this.saved;
    if (!saved) return;
    this.saved = null;
    const camera = saved.camera;
    if (camera.isDisposed()) return;
    camera.position.copyFrom(saved.position);
    if (saved.rotationQuaternion && camera.rotationQuaternion) camera.rotationQuaternion.copyFrom(saved.rotationQuaternion);
    camera.rotation.copyFrom(saved.rotation);
    camera.fov = saved.fov;
    [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom] = saved.ortho;
  }

  private zoomOrtho(camera: TargetCamera, fovDegrees: number): void {
    const [left, right, top, bottom] = [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom];
    if (left === null || right === null || top === null || bottom === null) return;
    const widened = Math.min(MAX_FOV, Math.max(MIN_FOV, ORTHO_REFERENCE_FOV + fovDegrees * DEGREES));
    const scale = Math.tan(widened / 2) / Math.tan(ORTHO_REFERENCE_FOV / 2);
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    camera.orthoLeft = cx + (left - cx) * scale;
    camera.orthoRight = cx + (right - cx) * scale;
    camera.orthoTop = cy + (top - cy) * scale;
    camera.orthoBottom = cy + (bottom - cy) * scale;
  }

  dispose(): void {
    this.restore();
    this.scene.onBeforeRenderObservable.remove(this.before);
    this.scene.onAfterRenderObservable.remove(this.after);
  }
}
