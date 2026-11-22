import { quatRotateVector } from "./euler";
import type { Quat, Vec3 } from "./math-rng";

export type PlayCameraLens = {
  projectionMode: "perspective" | "orthographic";
  fieldOfView: number;
  orthographicSize: number;
  nearClip: number;
  farClip: number;
};

export type CursorRay = {
  origin: Vec3;
  direction: Vec3;
  end: Vec3;
};

/**
 * A camera view as a screen shows it: its world pose and the terms of its projection matrix, in Babylon's row-vector,
 * left-handed convention (view space looks along +Z). A view-space point maps to normalized device coordinates as
 * `ndcX = x * scaleX / w + offsetX` and `ndcY = y * scaleY / w + offsetY`, where `w` is the depth `z` for a perspective
 * view and 1 for an orthographic one; +Y is up, so the top of the screen is `ndcY = 1`. Near and far are the view depths
 * a ray starts and ends at.
 */
export type CameraView = {
  position: Vec3;
  rotation: Quat;
  projection: "perspective" | "orthographic";
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  near: number;
  far: number;
};

/**
 * The view Play last drew the main Scene through while a camera actor was possessed, as the renderer reports it to the
 * game (`gameView`): the possessed camera's render slot and the view on screen, with everything only the renderer
 * applies (Spring Arm lag, bone attachments, Camera Shake, a Possess Camera With Blend under way, the lens extent and the
 * render aspect).
 */
export type DrawnCameraView = CameraView & { slotId: number };

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 1e-8)) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function finiteNonZero(value: number, fallback: number): number {
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

/**
 * The view an authored lens frames at `aspect` (width over height): a vertical field of view in degrees, or an
 * orthographic half-height widened to the aspect, as Play frames a Camera component with no lens extent.
 */
export function cameraViewFromLens(
  camera: { position: Vec3; rotation: Quat; lens: PlayCameraLens },
  aspect: number,
): CameraView {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const near = camera.lens.nearClip > 0 ? camera.lens.nearClip : 0.1;
  const far = camera.lens.farClip > near ? camera.lens.farClip : near + 1000;
  const pose = { position: camera.position, rotation: camera.rotation, near, far, offsetX: 0, offsetY: 0 };
  if (camera.lens.projectionMode === "orthographic") {
    const halfHeight = camera.lens.orthographicSize > 0 ? camera.lens.orthographicSize : 5;
    return { ...pose, projection: "orthographic", scaleX: 1 / (halfHeight * safeAspect), scaleY: 1 / halfHeight };
  }
  const fovY = (camera.lens.fieldOfView > 0 ? camera.lens.fieldOfView : 60) * (Math.PI / 180);
  const scaleY = 1 / Math.tan(fovY / 2);
  return { ...pose, projection: "perspective", scaleX: scaleY / safeAspect, scaleY };
}

/**
 * Canvas pixels → world ray through `view` (no Babylon): `cursor` and `canvas` share one unit (CSS pixels from the
 * canvas's top-left corner in Play), so only where the point lies across the canvas counts. The ray starts on the near
 * plane and ends on the far plane.
 */
export function deprojectViewRay(
  cursor: { x: number; y: number },
  canvas: { width: number; height: number },
  view: CameraView,
): CursorRay {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const ndcX = (cursor.x / width) * 2 - 1;
  const ndcY = 1 - (cursor.y / height) * 2;
  const near = Number.isFinite(view.near) && view.near > 0 ? view.near : 0.1;
  const far = Number.isFinite(view.far) && view.far > near ? view.far : near + 1000;
  // A view-space point under the cursor at depth 1 (perspective) or its offset on the view plane (orthographic).
  const localX = (ndcX - (Number.isFinite(view.offsetX) ? view.offsetX : 0)) / finiteNonZero(view.scaleX, 1);
  const localY = (ndcY - (Number.isFinite(view.offsetY) ? view.offsetY : 0)) / finiteNonZero(view.scaleY, 1);
  const { rotation, position } = view;

  if (view.projection === "orthographic") {
    const offset = quatRotateVector(rotation, { x: localX, y: localY, z: 0 });
    const forward = normalize(quatRotateVector(rotation, { x: 0, y: 0, z: 1 }));
    return {
      origin: add(add(position, offset), scale(forward, near)),
      direction: forward,
      end: add(add(position, offset), scale(forward, far)),
    };
  }

  const local = normalize({ x: localX, y: localY, z: 1 });
  const direction = normalize(quatRotateVector(rotation, local));
  // The clip planes sit at view depth near / far, which an off-center ray
  // reaches after near / cos and far / cos of its angle to the view axis.
  return {
    origin: add(position, scale(direction, near / local.z)),
    direction,
    end: add(position, scale(direction, far / local.z)),
  };
}

/**
 * Canvas CSS pixels → world ray through an authored Play camera lens (no Babylon), framed at the canvas's aspect.
 * Identity rotation looks toward +Z (left-handed, matching the editor).
 */
export function deprojectCursorRay(
  cursor: { x: number; y: number },
  canvas: { width: number; height: number },
  camera: {
    position: Vec3;
    rotation: Quat;
    lens: PlayCameraLens;
  },
): CursorRay {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  return deprojectViewRay(cursor, { width, height }, cameraViewFromLens(camera, width / height));
}
