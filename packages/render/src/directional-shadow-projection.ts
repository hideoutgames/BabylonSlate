import {
  Frustum,
  Matrix,
  Vector3,
  type DirectionalLight,
  type Scene,
} from "@babylonjs/core";
import type { ShadowSpatialIndex } from "./shadow-spatial-index";

/** Stable single-map fallback. The scene's aggregate XY bounds never size it. */
export function configureDirectionalShadowProjection(
  light: DirectionalLight,
  scene: Scene,
  distance: number,
  mapSize: number,
  spatial: ShadowSpatialIndex,
): void {
  const center = Vector3.Zero();
  const corner = Vector3.Zero();
  const clip = Matrix.Identity();
  light.autoCalcShadowZBounds = false;
  light.customProjectionMatrixBuilder = (view, _renderList, result) => {
    const camera = scene.activeCamera;
    if (!camera) {
      Matrix.IdentityToRef(result);
      return;
    }
    const aspect = scene.getEngine().getAspectRatio(camera);
    const radius = Math.max(
      distance,
      camera.mode === 1
        ? Math.max(
            Math.abs(camera.orthoLeft ?? 0),
            Math.abs(camera.orthoRight ?? 0),
            Math.abs(camera.orthoTop ?? 0),
            Math.abs(camera.orthoBottom ?? 0),
          )
        : distance * Math.tan(camera.fov / 2) * Math.max(1, aspect),
    );
    Vector3.TransformCoordinatesToRef(camera.globalPosition, view, center);
    const texel = (2 * radius) / mapSize;
    const x = Math.round(center.x / texel) * texel;
    const y = Math.round(center.y / texel) * texel;
    const minX = x - radius,
      maxX = x + radius,
      minY = y - radius,
      maxY = y + radius;
    Matrix.OrthoOffCenterLHToRef(
      minX,
      maxX,
      minY,
      maxY,
      center.z - radius,
      center.z + radius,
      result,
      scene.getEngine().isNDCHalfZRange,
    );
    view.multiplyToRef(result, clip);
    const candidates = spatial.queryPlanes(Frustum.GetPlanes(clip).slice(1));
    let near = center.z - radius;
    const far = center.z + radius;
    for (const mesh of candidates)
      for (const point of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        Vector3.TransformCoordinatesToRef(point, view, corner);
        near = Math.min(near, corner.z);
      }
    light.shadowMinZ = near;
    light.shadowMaxZ = far;
    Matrix.OrthoOffCenterLHToRef(
      minX,
      maxX,
      minY,
      maxY,
      near,
      Math.max(near + 1, far),
      result,
      scene.getEngine().isNDCHalfZRange,
    );
  };
}
