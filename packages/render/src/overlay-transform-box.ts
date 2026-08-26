export const OVERLAY_BOX_HANDLES = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
] as const;

export type OverlayBoxHandle = (typeof OVERLAY_BOX_HANDLES)[number];

export type OverlayBoxGesture = OverlayBoxHandle | "move" | "rotate";

/** Local XY AABB of visuals in the attached mesh's space (geometry, not scaled). */
export interface OverlayBoxLocalBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface OverlayBoxTransform {
  position: [number, number, number];
  /** Z rotation in radians (XY plane). */
  rotationZ: number;
  scale: [number, number, number];
}

export interface OverlayBoxSnap {
  enabled: boolean;
  translate: number;
  rotateDeg: number;
  scale: number;
}

export interface OverlayBoxDragStart {
  gesture: OverlayBoxGesture;
  bounds: OverlayBoxLocalBounds;
  transform: OverlayBoxTransform;
  /** Pointer in parent XY (world XY when unparented). */
  pointer: { x: number; y: number };
}

/** Floor for overlay resize so scale cannot pass through zero. */
export const OVERLAY_BOX_MIN_SCALE = 0.001;

function snapValue(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

function rotate2d(
  x: number,
  y: number,
  cos: number,
  sin: number,
): [number, number] {
  return [x * cos - y * sin, x * sin + y * cos];
}

function toBoxSpace(
  x: number,
  y: number,
  position: readonly [number, number, number],
  rotationZ: number,
): [number, number] {
  const cos = Math.cos(-rotationZ);
  const sin = Math.sin(-rotationZ);
  return rotate2d(x - position[0], y - position[1], cos, sin);
}

function applyOverlayBoxMove(
  start: OverlayBoxDragStart,
  pointer: { x: number; y: number },
  snap?: OverlayBoxSnap,
): OverlayBoxTransform {
  const { transform } = start;
  let x = transform.position[0] + (pointer.x - start.pointer.x);
  let y = transform.position[1] + (pointer.y - start.pointer.y);
  if (snap?.enabled) {
    x = snapValue(x, snap.translate);
    y = snapValue(y, snap.translate);
  }
  return {
    position: [x, y, transform.position[2]],
    rotationZ: transform.rotationZ,
    scale: [...transform.scale],
  };
}

function applyOverlayBoxResize(
  start: OverlayBoxDragStart,
  pointer: { x: number; y: number },
  snap?: OverlayBoxSnap,
): OverlayBoxTransform {
  const { bounds, gesture, transform } = start;
  const handle = gesture as OverlayBoxHandle;
  const [sx, sy, sz] = transform.scale;
  const theta = transform.rotationZ;
  const localW = bounds.maxX - bounds.minX;
  const localH = bounds.maxY - bounds.minY;
  const minW = OVERLAY_BOX_MIN_SCALE * Math.max(localW, OVERLAY_BOX_MIN_SCALE);
  const minH = OVERLAY_BOX_MIN_SCALE * Math.max(localH, OVERLAY_BOX_MIN_SCALE);

  let west = sx * bounds.minX;
  let east = sx * bounds.maxX;
  let south = sy * bounds.minY;
  let north = sy * bounds.maxY;
  const [bx, by] = toBoxSpace(pointer.x, pointer.y, transform.position, theta);

  const moveE = handle.includes("e");
  const moveW = handle.includes("w");
  const moveN = handle.includes("n");
  const moveS = handle.includes("s");
  if (moveE) east = Math.max(west + minW, bx);
  if (moveW) west = Math.min(east - minW, bx);
  if (moveN) north = Math.max(south + minH, by);
  if (moveS) south = Math.min(north - minH, by);

  let nextSx = localW > 0 ? (east - west) / localW : sx;
  let nextSy = localH > 0 ? (north - south) / localH : sy;
  nextSx = Math.max(OVERLAY_BOX_MIN_SCALE, nextSx);
  nextSy = Math.max(OVERLAY_BOX_MIN_SCALE, nextSy);
  if (snap?.enabled) {
    nextSx = Math.max(OVERLAY_BOX_MIN_SCALE, snapValue(nextSx, snap.scale));
    nextSy = Math.max(OVERLAY_BOX_MIN_SCALE, snapValue(nextSy, snap.scale));
  }

  if (moveE && !moveW) east = west + nextSx * localW;
  else if (moveW && !moveE) west = east - nextSx * localW;
  if (moveN && !moveS) north = south + nextSy * localH;
  else if (moveS && !moveN) south = north - nextSy * localH;

  const dx = west - nextSx * bounds.minX;
  const dy = south - nextSy * bounds.minY;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const [wx, wy] = rotate2d(dx, dy, cos, sin);
  return {
    position: [
      transform.position[0] + wx,
      transform.position[1] + wy,
      transform.position[2],
    ],
    rotationZ: theta,
    scale: [nextSx, nextSy, sz],
  };
}

export function overlayBoxVisualCenter(
  bounds: OverlayBoxLocalBounds,
  transform: OverlayBoxTransform,
): { x: number; y: number } {
  const cx = ((bounds.minX + bounds.maxX) / 2) * transform.scale[0];
  const cy = ((bounds.minY + bounds.maxY) / 2) * transform.scale[1];
  const cos = Math.cos(transform.rotationZ);
  const sin = Math.sin(transform.rotationZ);
  const [wx, wy] = rotate2d(cx, cy, cos, sin);
  return {
    x: transform.position[0] + wx,
    y: transform.position[1] + wy,
  };
}

function applyOverlayBoxRotate(
  start: OverlayBoxDragStart,
  pointer: { x: number; y: number },
  snap?: OverlayBoxSnap,
): OverlayBoxTransform {
  const { bounds, transform } = start;
  const center = overlayBoxVisualCenter(bounds, transform);
  const startAngle = Math.atan2(
    start.pointer.y - center.y,
    start.pointer.x - center.x,
  );
  const nowAngle = Math.atan2(pointer.y - center.y, pointer.x - center.x);
  let rotationZ = transform.rotationZ + (nowAngle - startAngle);
  if (snap?.enabled) {
    rotationZ = snapValue(rotationZ, (snap.rotateDeg * Math.PI) / 180);
  }
  const delta = rotationZ - transform.rotationZ;
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  const ox = transform.position[0] - center.x;
  const oy = transform.position[1] - center.y;
  const [rx, ry] = rotate2d(ox, oy, cos, sin);
  return {
    position: [center.x + rx, center.y + ry, transform.position[2]],
    rotationZ,
    scale: [...transform.scale],
  };
}

export function applyOverlayBoxDrag(
  start: OverlayBoxDragStart,
  pointer: { x: number; y: number },
  snap?: OverlayBoxSnap,
): OverlayBoxTransform {
  if (start.gesture === "move") {
    return applyOverlayBoxMove(start, pointer, snap);
  }
  if (start.gesture === "rotate") {
    return applyOverlayBoxRotate(start, pointer, snap);
  }
  return applyOverlayBoxResize(start, pointer, snap);
}
