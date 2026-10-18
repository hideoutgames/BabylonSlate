import {
  Frustum,
  Matrix,
  Plane,
  Vector3,
  type AbstractMesh,
  type Camera,
  type DirectionalLight,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { ShadowSpatialIndex } from "./shadow-spatial-index";

/**
 * One single-map sun generator's light-space box: [minX, maxX, minY, maxY,
 * near, far]. `drawing` is the render id its map was bound at for a pass, -1
 * after the pass; the fit refits only within that render id, so a draw that
 * threw before unbinding cannot leave later bindings refitting.
 */
type DirectionalFit = { generator: ShadowGenerator; drawing: number; box: number[] | null };

/**
 * Fits by generator, keyed by the projection matrix Babylon hands the light's
 * builder (`ShadowGenerator.projectionMatrix`, stable per generator). Every
 * generator of the light (the scene view's and each Full Quality capture's)
 * shares the light's one builder.
 */
const fits = new WeakMap<Matrix, DirectionalFit>();

/**
 * Fits `generator`'s single sun map when its map draws, and binds every other
 * pass with that fit until the map draws again. Babylon 9.29 rebuilds the
 * projection on every render id (ShadowLight never clears its
 * projection-compute flag), so without this a pass for another camera (a
 * capture, whose active camera differs) would bind a box the map was not drawn
 * with. A camera-keyed generator is fitted to its own camera; the scene view's
 * to the active camera it draws for.
 */
export function trackDirectionalShadowFit(generator: ShadowGenerator): void {
  const fit: DirectionalFit = { generator, drawing: -1, box: null };
  fits.set(generator.projectionMatrix, fit);
  const scene = generator.getLight().getScene();
  const map = generator.getShadowMap();
  // Before Babylon's own before-bind work, so the draw's first projection fits.
  map?.onBeforeBindObservable.add(() => { fit.drawing = scene.getRenderId(); }, undefined, true);
  map?.onAfterUnbindObservable.add(() => { fit.drawing = -1; });
}

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
  const planes = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
  const upstream = planes.slice(1);
  const casters: AbstractMesh[] = [];
  const scratch = [0, 0, 0, 0, 0, 0];
  light.autoCalcShadowZBounds = false;
  const ortho = (box: readonly number[], result: Matrix) =>
    Matrix.OrthoOffCenterLHToRef(
      box[0]!, box[1]!, box[2]!, box[3]!, box[4]!, Math.max(box[4]! + 1, box[5]!),
      result, scene.getEngine().isNDCHalfZRange,
    );
  light.customProjectionMatrixBuilder = (view, _renderList, result) => {
    const fit = fits.get(result);
    // A binding outside the map's own pass samples the image it holds.
    if (fit?.box && fit.drawing !== scene.getRenderId()) {
      ortho(fit.box, result);
      return;
    }
    const camera: Camera | null = fit?.generator.camera ?? scene.activeCamera;
    if (!camera) {
      Matrix.IdentityToRef(result);
      return;
    }
    const size = fit?.generator.getShadowMap()?.getSize().width ?? mapSize;
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
    const texel = (2 * radius) / size;
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
    Frustum.GetPlanesToRef(clip, planes);
    const candidates = spatial.queryPlanes(upstream, casters);
    let near = center.z - radius;
    const far = center.z + radius;
    for (const mesh of candidates)
      for (const point of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        Vector3.TransformCoordinatesToRef(point, view, corner);
        near = Math.min(near, corner.z);
      }
    // The light's own shadowMinZ/MaxZ stay untouched: they are shared by every
    // generator of the light, and a directional light's depth values ignore them.
    const box = fit ? (fit.box ??= [0, 0, 0, 0, 0, 0]) : scratch;
    box[0] = minX; box[1] = maxX; box[2] = minY; box[3] = maxY; box[4] = near; box[5] = far;
    ortho(box, result);
  };
}
