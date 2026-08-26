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

/**
 * Canvas CSS pixels → world ray through the Play camera (no Babylon).
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
  const ndcX = (cursor.x / width) * 2 - 1;
  const ndcY = 1 - (cursor.y / height) * 2;
  const aspect = width / height;
  const near = camera.lens.nearClip > 0 ? camera.lens.nearClip : 0.1;
  const far = camera.lens.farClip > near ? camera.lens.farClip : near + 1000;
  const rotation = camera.rotation;
  const position = camera.position;

  if (camera.lens.projectionMode === "orthographic") {
    const halfH =
      camera.lens.orthographicSize > 0 ? camera.lens.orthographicSize : 5;
    const offset = quatRotateVector(rotation, {
      x: ndcX * halfH * aspect,
      y: ndcY * halfH,
      z: 0,
    });
    const forward = normalize(
      quatRotateVector(rotation, { x: 0, y: 0, z: 1 }),
    );
    const origin = add(add(position, offset), scale(forward, near));
    return {
      origin,
      direction: forward,
      end: add(add(position, offset), scale(forward, far)),
    };
  }

  const fovY = (camera.lens.fieldOfView > 0 ? camera.lens.fieldOfView : 60) *
    (Math.PI / 180);
  const tanHalf = Math.tan(fovY / 2);
  const local = normalize({
    x: ndcX * tanHalf * aspect,
    y: ndcY * tanHalf,
    z: 1,
  });
  const direction = normalize(quatRotateVector(rotation, local));
  return {
    origin: add(position, scale(direction, near)),
    direction,
    end: add(position, scale(direction, far)),
  };
}
