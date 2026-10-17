import type { AbstractMesh, Camera, Plane, Scene } from "@babylonjs/core";

/** This frame's frustum: Scene.render recomputes camera matrices only after before-render observers run. */
function sees(camera: Camera, mesh: AbstractMesh): boolean {
  camera.getViewMatrix(); camera.getProjectionMatrix();
  return camera.isInFrustum(mesh);
}

/** A world-space box as a camera's culling test takes it: reused, so a view test allocates nothing. */
const probe = {
  minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
  isInFrustum(planes: Plane[]): boolean {
    for (let i = 0; i < planes.length; i++) {
      const n = planes[i]!.normal;
      // The corner furthest along the plane's normal: when even it lies behind the plane, the whole box does.
      if (n.x * (n.x >= 0 ? this.maxX : this.minX) + n.y * (n.y >= 0 ? this.maxY : this.minY) + n.z * (n.z >= 0 ? this.maxZ : this.minZ) + planes[i]!.d < 0) return false;
    }
    return true;
  },
  isCompletelyInFrustum(planes: Plane[]): boolean { return this.isInFrustum(planes); },
};

/** Where a world box lies relative to the scene's active cameras. */
export interface BoxView {
  /** Some active camera sees the box (true without a camera). */
  visible: boolean;
  /** Metres from the nearest active camera to the box (0 inside it and without a camera). */
  distance: number;
}

/** `out` for the world box [min, max]: whether an active camera sees it this frame and how far the nearest one is. Allocation-free. */
export function viewOfBox(scene: Scene, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: BoxView): BoxView {
  probe.minX = minX; probe.minY = minY; probe.minZ = minZ; probe.maxX = maxX; probe.maxY = maxY; probe.maxZ = maxZ;
  const cameras = scene.activeCameras, many = cameras !== null && cameras !== undefined && cameras.length > 0;
  const count = many ? cameras.length : scene.activeCamera ? 1 : 0;
  out.visible = count === 0; out.distance = 0;
  let nearest = Infinity;
  for (let i = 0; i < count; i++) {
    const camera = many ? cameras[i]! : scene.activeCamera!, at = camera.globalPosition;
    camera.getViewMatrix(); camera.getProjectionMatrix();
    if (!out.visible && camera.isInFrustum(probe)) out.visible = true;
    const dx = Math.max(minX - at.x, 0, at.x - maxX), dy = Math.max(minY - at.y, 0, at.y - maxY), dz = Math.max(minZ - at.z, 0, at.z - maxZ);
    nearest = Math.min(nearest, Math.hypot(dx, dy, dz));
  }
  if (count > 0) out.distance = nearest;
  return out;
}

/**
 * True when an active camera of the scene sees the mesh's bounds this frame; a scene without a camera counts as
 * seeing it. Safe to call from before-render observers and allocation-free.
 */
export function inActiveView(scene: Scene, mesh: AbstractMesh): boolean {
  const cameras = scene.activeCameras;
  if (cameras && cameras.length > 0) {
    for (let i = 0; i < cameras.length; i++) if (sees(cameras[i]!, mesh)) return true;
    return false;
  }
  const camera = scene.activeCamera;
  return !camera || sees(camera, mesh);
}
