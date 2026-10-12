import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
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
import { SELECTION_COLOR } from "./selection-style";
import type { RenderScheduler } from "./render-scheduler";
import { overlayMinTargetWorldSize } from "./overlay-touch-target";

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

  // Only the west/south edges feed the new position; the east/north edges
  // follow from the snapped scale.
  if (moveW && !moveE) west = east - nextSx * localW;
  if (moveS && !moveN) south = north - nextSy * localH;

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
/** Visual cubes/disc as a fraction of the 44px pick mesh. */
const OVERLAY_HANDLE_VISUAL_SCALE = 0.25;

const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();
const scratchLocal = new Vector3();
const scratchWorld = new Vector3();
const scratchEuler = new Vector3();
const scratchInv = Matrix.Identity();

function skipOverlayBoxVisual(mesh: AbstractMesh): boolean {
  const meta = mesh.metadata as {
    editorPickProxy?: boolean;
    editorColliderVisual?: boolean;
    text2d?: boolean;
  } | null;
  return Boolean(meta?.editorPickProxy || meta?.editorColliderVisual);
}

export function isText2DOverlayMesh(mesh: AbstractMesh): boolean {
  return Boolean(
    (mesh.metadata as { text2d?: boolean } | null | undefined)?.text2d,
  );
}

function overlayBoxSources(
  origin: AbstractMesh,
  visuals: readonly AbstractMesh[],
): AbstractMesh[] {
  const candidates = isText2DOverlayMesh(origin)
    ? [origin]
    : visuals.length > 0
      ? visuals
      : [origin];
  return candidates.filter((mesh) => !skipOverlayBoxVisual(mesh));
}

export function overlayBoxLocalBounds(
  origin: AbstractMesh,
  visuals: readonly AbstractMesh[] = [],
): OverlayBoxLocalBounds {
  return boundsOfSources(origin, overlayBoxSources(origin, visuals));
}

function boundsOfSources(
  origin: AbstractMesh,
  sources: readonly AbstractMesh[],
): OverlayBoxLocalBounds {
  if (sources.length === 0) {
    return { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 };
  }
  origin.computeWorldMatrix(true);
  origin.getWorldMatrix().invertToRef(scratchInv);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const visual of sources) {
    visual.computeWorldMatrix(true);
    visual.refreshBoundingInfo(false, false);
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

/**
 * Everything `layout` reads from the scene. A frame whose snapshot matches the
 * one taken after the last layout cannot change the box, so it skips the
 * bounds refresh. Numbers are compared with `Object.is`, so a signed zero is a
 * change and NaN is stable.
 */
interface LayoutInputs {
  numbers: number[];
  refs: unknown[];
}

function pushMatrix(numbers: number[], matrix: Matrix): void {
  const m = matrix.m;
  for (let i = 0; i < 16; i++) numbers.push(m[i]!);
}

function recordLayoutInputs(
  into: LayoutInputs,
  origin: AbstractMesh,
  sources: readonly AbstractMesh[],
  handleSize: number,
): void {
  const { numbers, refs } = into;
  numbers.length = 0;
  refs.length = 0;
  numbers.push(handleSize);
  pushMatrix(numbers, origin.computeWorldMatrix(true));
  for (const source of sources) {
    pushMatrix(numbers, source.computeWorldMatrix(true));
    // The stored bounds are what Babylon updates when geometry is edited;
    // swapped geometry or position data is caught by the references below.
    const info = source.getBoundingInfo();
    const { minimum, maximum } = info;
    numbers.push(
      minimum.x,
      minimum.y,
      minimum.z,
      maximum.x,
      maximum.y,
      maximum.z,
      info.isLocked ? 1 : 0,
      source.getTotalVertices(),
    );
    refs.push(
      source,
      info,
      source.getVertexBuffer(VertexBuffer.PositionKind)?.getData() ?? null,
    );
  }
}

function sameLayoutInputs(a: LayoutInputs, b: LayoutInputs): boolean {
  if (a.numbers.length !== b.numbers.length || a.refs.length !== b.refs.length) {
    return false;
  }
  for (let i = 0; i < a.numbers.length; i++) {
    if (!Object.is(a.numbers[i], b.numbers[i])) return false;
  }
  for (let i = 0; i < a.refs.length; i++) {
    if (a.refs[i] !== b.refs[i]) return false;
  }
  return true;
}

export function overlayTextWrapFromResize(
  startScale: readonly [number, number, number],
  nextScale: readonly [number, number, number],
  wrapWidthPx: number,
  wrapHeightPx: number,
): { wrapWidth: number; wrapHeight: number } {
  const rx = startScale[0] !== 0 ? nextScale[0] / startScale[0] : 1;
  const ry = startScale[1] !== 0 ? nextScale[1] / startScale[1] : 1;
  return {
    wrapWidth: Math.max(1, wrapWidthPx * Math.abs(rx)),
    wrapHeight: Math.max(1, wrapHeightPx * Math.abs(ry)),
  };
}

type Text2DOverlayMeta = {
  text2d?: boolean;
  text2dWrapWidth?: number;
  text2dWrapHeight?: number;
  text2dPendingWrap?: { wrapWidth: number; wrapHeight: number };
  text2dDragStartScale?: [number, number, number];
};

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
  start?: OverlayBoxTransform,
): void {
  if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  mesh.position.set(next.position[0], next.position[1], next.position[2]);
  mesh.rotationQuaternion ??= new Quaternion();
  Quaternion.FromEulerAnglesToRef(0, 0, next.rotationZ, mesh.rotationQuaternion);
  const meta = (mesh.metadata ?? {}) as Text2DOverlayMeta;
  if (isText2DOverlayMesh(mesh) && start) {
    const wrapWidthPx =
      typeof meta.text2dWrapWidth === "number" && meta.text2dWrapWidth > 0
        ? meta.text2dWrapWidth
        : Math.max(1, mesh.getBoundingInfo().boundingBox.extendSize.x * 2 * 100);
    const wrapHeightPx =
      typeof meta.text2dWrapHeight === "number" && meta.text2dWrapHeight > 0
        ? meta.text2dWrapHeight
        : Math.max(1, mesh.getBoundingInfo().boundingBox.extendSize.y * 2 * 100);
    mesh.metadata = {
      ...meta,
      text2dPendingWrap: overlayTextWrapFromResize(
        start.scale,
        next.scale,
        wrapWidthPx,
        wrapHeightPx,
      ),
      text2dDragStartScale: [...start.scale] as [number, number, number],
    };
    mesh.scaling.set(next.scale[0], next.scale[1], next.scale[2]);
    const invX = next.scale[0] !== 0 ? start.scale[0] / next.scale[0] : 1;
    const invY = next.scale[1] !== 0 ? start.scale[1] / next.scale[1] : 1;
    // Only this text's own glyph quads counter-scale; child actors and helpers
    // keep their scale. A glyph's rest scale (bold MSDF) is kept across moves.
    for (const child of mesh.getChildMeshes(true)) {
      const glyph = child.metadata as { text2dGlyph?: boolean; text2dRestScale?: [number, number] } | null;
      if (!glyph?.text2dGlyph) continue;
      const rest = glyph.text2dRestScale ?? [child.scaling.x, child.scaling.y];
      if (!glyph.text2dRestScale) child.metadata = { ...glyph, text2dRestScale: rest };
      child.scaling.set(rest[0] * invX, rest[1] * invY, child.scaling.z);
    }
    return;
  }
  mesh.scaling.set(next.scale[0], next.scale[1], next.scale[2]);
}

function overlayHandleWorldSize(scene: Scene, cssHeight?: number): number {
  const camera = scene.activeCamera;
  const canvasHeight =
    (cssHeight != null && cssHeight > 0
      ? cssHeight
      : scene.getEngine().getRenderingCanvas()?.clientHeight) ?? 0;
  const top = camera?.orthoTop ?? 0;
  const bottom = camera?.orthoBottom ?? 0;
  const worldH = Math.abs(top - bottom);
  const sized = overlayMinTargetWorldSize(TOUCH_HANDLE_PX, canvasHeight, worldH);
  return sized > 0 ? sized : FALLBACK_HANDLE_WORLD;
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
  scheduler?: Pick<RenderScheduler, "invalidate">;
  onDragStart?: () => void;
  onDrag?: () => void;
  onDragEnd?: () => void;
  /** View-canvas CSS height; 44px handles use this, not the drawing buffer. */
  canvasCssHeight?: () => number;
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
  const color = SELECTION_COLOR;
  const fill = unlitMaterial("overlay-box-fill", util, color);
  const interiorMat = unlitMaterial("overlay-box-interior", util, color, 0);

  const root = new TransformNode("overlay-box-root", util);
  const boxScale = new TransformNode("overlay-box-scale", util);
  boxScale.parent = root;

  const frame: LinesMesh = CreateLines(
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
    handle.visibility = 0;
    handle.isVisible = true;
    handle.parent = root;
    const visual = CreateBox(`overlay-box-handle-${id}-visual`, { size: 1 }, util);
    visual.material = fill;
    visual.isPickable = false;
    visual.parent = handle;
    visual.scaling.setAll(OVERLAY_HANDLE_VISUAL_SCALE);
    handles.set(id, handle);
  }

  // A unit segment; layout scales it to the zoom-dependent stem length.
  const stem: LinesMesh = CreateLines(
    "overlay-box-rotate-stem",
    { points: stemPoints(1) },
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
  knob.visibility = 0;
  knob.isVisible = true;
  knob.parent = root;
  const knobVisual = CreateDisc(
    "overlay-box-rotate-visual",
    { radius: 0.5, tessellation: 24, sideOrientation: Mesh.DOUBLESIDE },
    util,
  );
  knobVisual.material = fill;
  knobVisual.isPickable = false;
  knobVisual.parent = knob;
  knobVisual.scaling.setAll(OVERLAY_HANDLE_VISUAL_SCALE);

  let attached: AbstractMesh | null = null;
  let visuals: AbstractMesh[] = [];
  let snap: OverlayBoxSnap | undefined;
  let session: OverlayBoxDragStart | null = null;
  let dragging = false;

  const pointerFrom = (world: Vector3): { x: number; y: number } => {
    if (!attached) return { x: world.x, y: world.y };
    return worldToParentXy(attached, world);
  };

  const frameInputs: LayoutInputs = { numbers: [], refs: [] };
  const laidOutInputs: LayoutInputs = { numbers: [], refs: [] };
  let laidOut = false;

  // Attach and drag always take the full path; the per-frame pass passes
  // `skipIfUnchanged` and returns early while nothing layout reads has moved.
  const layout = (skipIfUnchanged = false) => {
    const show = attached !== null;
    root.setEnabled(show);
    if (!attached) {
      if (laidOut) {
        // Do not keep the last selection's meshes and vertex data alive.
        laidOut = false;
        frameInputs.refs.length = 0;
        laidOutInputs.refs.length = 0;
      }
      return;
    }
    const handleSize = overlayHandleWorldSize(
      originalScene,
      options.canvasCssHeight?.(),
    );
    const sources = overlayBoxSources(attached, visuals);
    if (skipIfUnchanged && laidOut) {
      recordLayoutInputs(frameInputs, attached, sources, handleSize);
      if (sameLayoutInputs(frameInputs, laidOutInputs)) return;
    }
    attached.computeWorldMatrix(true);
    const bounds = boundsOfSources(attached, sources);
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
    root.rotationQuaternion ??= new Quaternion();
    scratchRotation.toEulerAnglesToRef(scratchEuler);
    Quaternion.FromEulerAnglesToRef(0, 0, scratchEuler.z, root.rotationQuaternion);

    const worldWidth = Vector3.TransformNormalFromFloatsToRef(
      bounds.maxX - bounds.minX,
      0,
      0,
      attached.getWorldMatrix(),
      scratchWorld,
    ).length();
    const worldHeight = Vector3.TransformNormalFromFloatsToRef(
      0,
      bounds.maxY - bounds.minY,
      0,
      attached.getWorldMatrix(),
      scratchWorld,
    ).length();
    const halfW = Math.max(worldWidth / 2, 1e-4);
    const halfH = Math.max(worldHeight / 2, 1e-4);
    boxScale.scaling.set(worldWidth || 1e-4, worldHeight || 1e-4, 1);

    const visualSize = handleSize * OVERLAY_HANDLE_VISUAL_SCALE;
    const stemLen = visualSize * ROTATE_STEM_HANDLES;
    for (const [id, handle] of handles) {
      const offset = HANDLE_OFFSET[id];
      handle.position.set(offset.x * halfW, offset.y * halfH, -visualSize);
      handle.scaling.set(handleSize, handleSize, handleSize);
    }
    stem.position.set(0, halfH, -visualSize * 0.5);
    stem.scaling.set(1, stemLen, 1);
    knob.position.set(0, halfH + stemLen, -visualSize * 1.5);
    knob.scaling.set(handleSize, handleSize, handleSize);
    // Recorded after the bounds refresh, which may have corrected stale bounds.
    recordLayoutInputs(laidOutInputs, attached, sources, handleSize);
    laidOut = true;
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
      session.transform,
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
    if (!dragging) layout(true);
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
