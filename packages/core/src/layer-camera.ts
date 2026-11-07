/**
 * A Layer Camera's Play pose: the layer-space point at the centre of the view,
 * its roll in degrees (positive turns the camera counter-clockwise, so content
 * turns clockwise on screen) and its zoom (2 shows half the view bounds at
 * twice the size). Every Scene and every Scene Layer instance owns one. It
 * starts at the document's authored Camera Location, and only scripts move it;
 * the moved pose is session state, never saved.
 */
export interface LayerCameraState {
  x: number;
  y: number;
  rotation: number;
  zoom: number;
}

export const DEFAULT_LAYER_CAMERA_STATE: Readonly<LayerCameraState> = Object.freeze({ x: 0, y: 0, rotation: 0, zoom: 1 });

/**
 * A Scene's Layer Camera sits this far in front of the XY plane (looking
 * along +Z) and draws to {@link WORLD_LAYER_CAMERA_FAR_CLIP}, so it sees
 * world content from z = -499.9 to z = 500. A Scene Layer's camera sits 10
 * units in front of its flat layer instead.
 */
export const WORLD_LAYER_CAMERA_DISTANCE = 500;
export const WORLD_LAYER_CAMERA_NEAR_CLIP = 0.1;
export const WORLD_LAYER_CAMERA_FAR_CLIP = 1000;

/** Zoom never reaches 0, where the view would have no size (an overshooting tween can ask for less). */
export const LAYER_CAMERA_MIN_ZOOM = 0.01;

/** The pose a Layer Camera starts in: centred on the authored Camera Location, unrolled, zoom 1. */
export function layerCameraStartState(location: readonly [number, number] | null | undefined): LayerCameraState {
  const x = Number(location?.[0]);
  const y = Number(location?.[1]);
  return {
    ...DEFAULT_LAYER_CAMERA_STATE,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

/**
 * `camera` with `changes` applied: non-finite values keep the current one and
 * zoom is raised to {@link LAYER_CAMERA_MIN_ZOOM}.
 */
export function updateLayerCameraState(
  camera: Readonly<LayerCameraState>,
  changes: { x?: unknown; y?: unknown; rotation?: unknown; zoom?: unknown },
): LayerCameraState {
  const pick = (value: unknown, current: number) => {
    const number = Number(value);
    return value !== undefined && value !== null && Number.isFinite(number) ? number : current;
  };
  return {
    x: pick(changes.x, camera.x),
    y: pick(changes.y, camera.y),
    rotation: pick(changes.rotation, camera.rotation),
    zoom: Math.max(LAYER_CAMERA_MIN_ZOOM, pick(changes.zoom, camera.zoom)),
  };
}

export function sameLayerCameraState(a: Readonly<LayerCameraState>, b: Readonly<LayerCameraState>): boolean {
  return a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.zoom === b.zoom;
}
