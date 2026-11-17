import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import {
  DEFAULT_LAYER_CAMERA_STATE,
  pixelMatchedView,
  sceneLayerViewBounds,
  type PixelMatchedContext,
  WORLD_LAYER_CAMERA_DISTANCE,
  WORLD_LAYER_CAMERA_FAR_CLIP,
  WORLD_LAYER_CAMERA_NEAR_CLIP,
  type LayerCameraState,
} from "@haptic/core";

const WORLD_LAYER_CAMERA_NAME = "playLayerCamera";

/** The default Layer Camera Width × Height of a Scene (`createDefaultSceneSettings().cameraBounds2D`). */
const DEFAULT_BOUNDS = { width: 16, height: 9 };

/**
 * The main Scene's Layer Camera in Play: a detached orthographic
 * `UniversalCamera` `WORLD_LAYER_CAMERA_DISTANCE` in front of its centre,
 * looking along +Z and rolled by its rotation, framing the Layer Camera
 * Width × Height widened (or heightened) to the drawn buffer's aspect, as a
 * Scene Layer's camera frames its canvas, then divided by its zoom. Play looks
 * through it whenever no camera actor is possessed.
 */
export interface WorldLayerCamera {
  readonly camera: UniversalCamera;
  /** A `sceneCamera` command: the pose and Layer Camera Width × Height of the current main Scene. */
  set(state: Readonly<LayerCameraState>, bounds: { width: number; height: number }): void;
  /** The drawn buffer's aspect, and how much more world a pixelated buffer extended past its design size shows. */
  fit(aspect: number, extent?: number): void;
  /**
   * Pixel-matches the camera (`pixel-matched-camera.ts`), or with null frames its Width × Height again: its bounds
   * fitted to the design aspect and divided by its zoom pick the whole ratio, and the view covers the whole output.
   */
  pixelMatch(context: PixelMatchedContext | null): void;
  dispose(): void;
}

/**
 * Half the world a Layer Camera with Width × Height `bounds` and `zoom` shows: the bounds fitted to the buffer's
 * aspect over the zoom, widened by the lens extent, or the pixel-matched view of the bounds fitted to the design aspect.
 */
export function layerCameraHalfSize(
  bounds: { width: number; height: number },
  zoom: number,
  aspect: number,
  extent: number,
  matched: PixelMatchedContext | null,
): { halfWidth: number; halfHeight: number } {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (matched) {
    const designAspect = matched.design.width / Math.max(1, matched.design.height);
    const view = pixelMatchedView(sceneLayerViewBounds(bounds, designAspect).height / safeZoom, matched);
    return { halfWidth: view.width / 2, halfHeight: view.height / 2 };
  }
  const view = sceneLayerViewBounds(bounds, aspect);
  return { halfWidth: view.width / 2 / safeZoom * extent, halfHeight: view.height / 2 / safeZoom * extent };
}

export function createWorldLayerCamera(scene: Scene): WorldLayerCamera {
  const camera = new UniversalCamera(WORLD_LAYER_CAMERA_NAME, new Vector3(0, 0, -WORLD_LAYER_CAMERA_DISTANCE), scene);
  camera.inputs.clear();
  camera.detachControl();
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = WORLD_LAYER_CAMERA_NEAR_CLIP;
  camera.maxZ = WORLD_LAYER_CAMERA_FAR_CLIP;
  let state: LayerCameraState = { ...DEFAULT_LAYER_CAMERA_STATE };
  let bounds = { ...DEFAULT_BOUNDS };
  let aspect = DEFAULT_BOUNDS.width / DEFAULT_BOUNDS.height;
  let extent = 1;
  let matched: PixelMatchedContext | null = null;
  const apply = () => {
    camera.rotationQuaternion = null;
    camera.position.set(state.x, state.y, -WORLD_LAYER_CAMERA_DISTANCE);
    // Yaw and pitch 0 look along +Z; Z is the roll, positive counter-clockwise like the Scene Layer camera.
    camera.rotation.set(0, 0, state.rotation * Math.PI / 180);
    const { halfWidth, halfHeight } = layerCameraHalfSize(bounds, state.zoom, aspect, extent, matched);
    camera.orthoTop = halfHeight;
    camera.orthoBottom = -halfHeight;
    camera.orthoLeft = -halfWidth;
    camera.orthoRight = halfWidth;
    camera.getViewMatrix(true);
    camera.getProjectionMatrix(true);
  };
  apply();
  return {
    camera,
    set(next, nextBounds) {
      state = { ...next };
      bounds = { ...nextBounds };
      apply();
    },
    pixelMatch(context) {
      if (JSON.stringify(context) === JSON.stringify(matched)) return;
      matched = context ? { design: { ...context.design }, output: { ...context.output }, pixelsPerUnit: context.pixelsPerUnit } : null;
      apply();
    },
    fit(nextAspect, nextExtent = 1) {
      const safeAspect = Number.isFinite(nextAspect) && nextAspect > 0 ? nextAspect : aspect;
      const safeExtent = Number.isFinite(nextExtent) && nextExtent > 1 ? nextExtent : 1;
      if (safeAspect === aspect && safeExtent === extent) return;
      aspect = safeAspect;
      extent = safeExtent;
      apply();
    },
    dispose() {
      camera.dispose();
    },
  };
}
