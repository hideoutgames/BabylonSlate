import { Color3 } from "@babylonjs/core/Maths/math.color";
import {
  Matrix,
  Quaternion,
  Vector3,
} from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PointerDragBehavior } from "@babylonjs/core/Behaviors/Meshes/pointerDragBehavior";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer";
import { SELECTION_OUTLINE_COLOR } from "./selection-outline";
import type { RenderScheduler } from "./render-scheduler";

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

const HANDLE_OFFSET: Record<OverlayBoxHandle, { x: number; y: number }> = {
  n: { x: 0, y: 1 },
  s: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
  ne: { x: 1, y: 1 },
  nw: { x: -1, y: 1 },
  se: { x: 1, y: -1 },
  sw: { x: -1, y: -1 },
};

const FALLBACK_HANDLE_WORLD = 0.2;
const ROTATE_STEM_HANDLES = 1.75;
const TOUCH_HANDLE_PX = 44;

const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();
const scratchLocal = new Vector3();
const scratchWorld = new Vector3();
const scratchInv = Matrix.Identity();

function skipOverlayBoxVisual(mesh: AbstractMesh): boolean {
  const meta = mesh.metadata as {
    editorPickProxy?: boolean;
    editorColliderVisual?: boolean;
  } | null;
  return Boolean(meta?.editorPickProxy || meta?.editorColliderVisual);
}

export function overlayBoxLocalBounds(
  origin: AbstractMesh,
  visuals: readonly AbstractMesh[] = [],
): OverlayBoxLocalBounds {
  const candidates = visuals.length > 0 ? visuals : [origin];
  const sources = candidates.filter((mesh) => !skipOverlayBoxVisual(mesh));
  const measured = sources.length > 0 ? sources : [origin];
  origin.computeWorldMatrix(true);
  origin.getWorldMatrix().invertToRef(scratchInv);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const visual of measured) {
    visual.computeWorldMatrix(true);
    visual.refreshBoundingInfo();
    for (const corner of visual.getBoundingInfo().boundingBox.vectorsWorld) {
      Vector3.TransformCoordinatesToRef(corner, scratchInv, scratchLocal);
      minX = Math.min(minX, scratchLocal.x);
      maxX = Math.max(maxX, scratchLocal.x);
      minY = Math.min(minY, scratchLocal.y);
      maxY = Math.max(maxY, scratchLocal.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 };
  }
  return { minX, maxX, minY, maxY };
}

export function readOverlayBoxTransform(mesh: AbstractMesh): OverlayBoxTransform {
  const rotation = mesh.rotationQuaternion
    ? mesh.rotationQuaternion
    : Quaternion.FromEulerVector(mesh.rotation);
  return {
    position: [mesh.position.x, mesh.position.y, mesh.position.z],
    rotationZ: rotation.toEulerAngles().z,
    scale: [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z],
  };
}

export function writeOverlayBoxTransform(
  mesh: AbstractMesh,
  next: OverlayBoxTransform,
): void {
  if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  mesh.position.set(next.position[0], next.position[1], next.position[2]);
  mesh.rotationQuaternion ??= new Quaternion();
  Quaternion.FromEulerAnglesToRef(0, 0, next.rotationZ, mesh.rotationQuaternion);
  mesh.scaling.set(next.scale[0], next.scale[1], next.scale[2]);
}

function overlayHandleWorldSize(scene: Scene): number {
  const camera = scene.activeCamera;
  const height = scene.getEngine().getRenderHeight();
  if (!camera || height <= 0) return FALLBACK_HANDLE_WORLD;
  const top = camera.orthoTop ?? 0;
  const bottom = camera.orthoBottom ?? 0;
  const worldH = Math.abs(top - bottom);
  if (!(worldH > 0)) return FALLBACK_HANDLE_WORLD;
  return (TOUCH_HANDLE_PX / height) * worldH;
}

function unlitMaterial(
  name: string,
  scene: Scene,
  color: Color3,
  alpha = 1,
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.emissiveColor = color.clone();
  material.diffuseColor = color.clone();
  material.specularColor = Color3.Black();
  material.alpha = alpha;
  material.backFaceCulling = false;
  return material;
}

function worldToParentXy(
  mesh: AbstractMesh,
  world: Vector3,
): { x: number; y: number } {
  const parent = mesh.parent;
  if (!parent) return { x: world.x, y: world.y };
  parent.computeWorldMatrix(true);
  parent.getWorldMatrix().invertToRef(scratchInv);
  Vector3.TransformCoordinatesToRef(world, scratchInv, scratchLocal);
  return { x: scratchLocal.x, y: scratchLocal.y };
}

function rectPoints(halfW: number, halfH: number): Vector3[] {
  return [
    new Vector3(-halfW, -halfH, 0),
    new Vector3(halfW, -halfH, 0),
    new Vector3(halfW, halfH, 0),
    new Vector3(-halfW, halfH, 0),
    new Vector3(-halfW, -halfH, 0),
  ];
}

function stemPoints(length: number): Vector3[] {
  return [new Vector3(0, 0, 0), new Vector3(0, length, 0)];
}

export interface OverlayTransformBoxOptions {
  scheduler?: Pick<RenderScheduler, "invalidate" | "acquireContinuous">;
  onDragStart?: () => void;
  onDrag?: () => void;
  onDragEnd?: () => void;
}

export interface OverlayTransformBox {
  attachTo: (mesh: AbstractMesh | null, visuals?: AbstractMesh[]) => void;
  attachedMesh: () => AbstractMesh | null;
  isDragging: () => boolean;
  setSnap: (snap: OverlayBoxSnap) => void;
  dispose: () => void;
}

export function createOverlayTransformBox(
  layer: UtilityLayerRenderer,
  originalScene: Scene,
  options: OverlayTransformBoxOptions = {},
): OverlayTransformBox {
  const util = layer.utilityLayerScene;
  const color = SELECTION_OUTLINE_COLOR;
  const fill = unlitMaterial("overlay-box-fill", util, color);
  const interiorMat = unlitMaterial("overlay-box-interior", util, color, 0);

  const root = new TransformNode("overlay-box-root", util);
  const boxScale = new TransformNode("overlay-box-scale", util);
  boxScale.parent = root;

  let frame: LinesMesh = CreateLines(
    "overlay-box-frame",
    { points: rectPoints(0.5, 0.5), updatable: true },
    util,
  );
  frame.color = color;
  frame.isPickable = false;
  frame.parent = boxScale;

  const interior = CreatePlane("overlay-box-interior", { size: 1 }, util);
  interior.material = interiorMat;
  interior.visibility = 0;
  interior.isVisible = true;
  interior.isPickable = true;
  interior.parent = boxScale;

  const handles = new Map<OverlayBoxHandle, Mesh>();
  for (const id of OVERLAY_BOX_HANDLES) {
    const handle = CreateBox(`overlay-box-handle-${id}`, { size: 1 }, util);
    handle.material = fill;
    handle.isPickable = true;
    handle.parent = root;
    handles.set(id, handle);
  }

  let stem: LinesMesh = CreateLines(
    "overlay-box-rotate-stem",
    { points: stemPoints(1), updatable: true },
    util,
  );
  stem.color = color;
  stem.isPickable = false;
  stem.parent = root;

  const knob = CreateDisc(
    "overlay-box-rotate",
    { radius: 0.5, tessellation: 24, sideOrientation: Mesh.DOUBLESIDE },
    util,
  );
  knob.material = fill;
  knob.isPickable = true;
  knob.parent = root;

  let attached: AbstractMesh | null = null;
  let visuals: AbstractMesh[] = [];
  let snap: OverlayBoxSnap | undefined;
  let session: OverlayBoxDragStart | null = null;
  let dragging = false;

  const pointerFrom = (world: Vector3): { x: number; y: number } => {
    if (!attached) return { x: world.x, y: world.y };
    return worldToParentXy(attached, world);
  };

  const layout = () => {
    const show = attached !== null;
    root.setEnabled(show);
    if (!attached) return;
    attached.computeWorldMatrix(true);
    const bounds = overlayBoxLocalBounds(attached, visuals);
    attached.getWorldMatrix().decompose(
      scratchScale,
      scratchRotation,
      scratchPosition,
    );
    const localCx = (bounds.minX + bounds.maxX) / 2;
    const localCy = (bounds.minY + bounds.maxY) / 2;
    scratchLocal.set(localCx, localCy, 0);
    Vector3.TransformCoordinatesToRef(
      scratchLocal,
      attached.getWorldMatrix(),
      scratchWorld,
    );
    root.position.set(scratchWorld.x, scratchWorld.y, scratchWorld.z);
    root.rotationQuaternion = Quaternion.FromEulerAngles(
      0,
      0,
      scratchRotation.toEulerAngles().z,
    );

    const worldWidth = Vector3.TransformNormal(
      new Vector3(bounds.maxX - bounds.minX, 0, 0),
      attached.getWorldMatrix(),
    ).length();
    const worldHeight = Vector3.TransformNormal(
      new Vector3(0, bounds.maxY - bounds.minY, 0),
      attached.getWorldMatrix(),
    ).length();
    const halfW = Math.max(worldWidth / 2, 1e-4);
    const halfH = Math.max(worldHeight / 2, 1e-4);
    boxScale.scaling.set(worldWidth || 1e-4, worldHeight || 1e-4, 1);

    const handleSize = overlayHandleWorldSize(originalScene);
    const stemLen = handleSize * ROTATE_STEM_HANDLES;
    for (const [id, handle] of handles) {
      const offset = HANDLE_OFFSET[id];
      handle.position.set(offset.x * halfW, offset.y * halfH, -handleSize);
      handle.scaling.set(handleSize, handleSize, handleSize);
    }
    stem.position.set(0, halfH, -handleSize * 0.5);
    stem = CreateLines(
      "overlay-box-rotate-stem",
      { points: stemPoints(stemLen), instance: stem },
      util,
    );
    knob.position.set(0, halfH + stemLen, -handleSize);
    knob.scaling.set(handleSize, handleSize, handleSize);
  };

  const begin = (
    gesture: OverlayBoxGesture,
    world: Vector3,
  ) => {
    if (!attached) return;
    session = {
      gesture,
      bounds: overlayBoxLocalBounds(attached, visuals),
      transform: readOverlayBoxTransform(attached),
      pointer: pointerFrom(world),
    };
    dragging = true;
    options.onDragStart?.();
  };

  const update = (world: Vector3) => {
    if (!session || !attached) return;
    writeOverlayBoxTransform(
      attached,
      applyOverlayBoxDrag(session, pointerFrom(world), snap),
    );
    layout();
    options.scheduler?.invalidate("gizmo");
    options.onDrag?.();
  };

  const finish = (world: Vector3) => {
    if (session && attached) update(world);
    session = null;
    dragging = false;
    options.scheduler?.invalidate("gizmo");
    options.onDragEnd?.();
  };

  const bind = (mesh: Mesh, gesture: OverlayBoxGesture) => {
    const behavior = new PointerDragBehavior({
      dragPlaneNormal: Vector3.Forward(),
    });
    behavior.moveAttached = false;
    behavior.useObjectOrientationForDragging = false;
    mesh.addBehavior(behavior, true);
    behavior.onDragStartObservable.add((event) => {
      begin(gesture, event.dragPlanePoint);
    });
    behavior.onDragObservable.add((event) => {
      update(event.dragPlanePoint);
    });
    behavior.onDragEndObservable.add((event) => {
      finish(event.dragPlanePoint);
    });
  };

  bind(interior, "move");
  bind(knob, "rotate");
  for (const [id, handle] of handles) bind(handle, id);

  const observer = util.onBeforeRenderObservable.add(() => {
    if (!dragging) layout();
  });

  root.setEnabled(false);

  return {
    attachTo: (mesh, nextVisuals) => {
      attached = mesh;
      visuals = nextVisuals ? [...nextVisuals] : [];
      layout();
    },
    attachedMesh: () => attached,
    isDragging: () => dragging,
    setSnap: (next) => {
      snap = next.enabled ? next : undefined;
    },
    dispose: () => {
      if (observer) util.onBeforeRenderObservable.remove(observer);
      for (const handle of handles.values()) handle.dispose();
      handles.clear();
      interior.dispose();
      frame.dispose();
      stem.dispose();
      knob.dispose();
      boxScale.dispose();
      root.dispose();
      fill.dispose();
      interiorMat.dispose();
    },
  };
}
