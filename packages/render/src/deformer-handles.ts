import { Color3, Vector3, type Camera, type Scene, type UtilityLayerRenderer } from "@babylonjs/core";
import { parseDeformerProperties, type DeformerProperties } from "@babylonslate/core";
import { latticeFitBounds, setMeshLatticeDeformer } from "./lattice-deformer";
import { createShapeHandles, type ShapeHandlesHost, type ShapeHandlesOptions, type ShapeHandleTarget, type ShapePoint } from "./shape-handles";

const FORWARD = new Vector3();
const FALLBACK_FORWARD = Vector3.Forward();
/** Babylon's Lattice keeps every axis at least this long. */
const MIN_CAGE_SIZE = 0.0001;
const POINT_COLOR = new Color3(1, 0.72, 0.28);

function cameraForward(camera: Camera): Vector3 {
  const m = camera.getWorldMatrix().m;
  return FORWARD.set(m[8]!, m[9]!, m[10]!).normalize();
}

export interface DeformerHandleTarget extends ShapeHandleTarget {
  /** The component is the target's applied cage, so handle drags deform the mesh live. */
  preview: boolean;
}

/** Authored properties plus the cage box the renderer uses, in the target's local space. */
export interface DeformerHandleBody extends DeformerProperties {
  cageMin: ShapePoint;
  cageMax: ShapePoint;
  preview: boolean;
}

export interface DeformerHandle {
  id: string;
  kind: "point";
  position: ShapePoint;
  /** Control index: x + resolutionX * (y + resolutionY * z). */
  index: number;
}

/** Fit To Mesh uses the target's undeformed bounds; otherwise the authored box. */
export function deformerHandleBody(properties: unknown, fit: { min: ShapePoint; max: ShapePoint } | null, preview: boolean): DeformerHandleBody {
  const parsed = parseDeformerProperties(properties);
  const min: ShapePoint = parsed.fitToMesh && fit ? [...fit.min] : [...parsed.boundsMin];
  const max: ShapePoint = parsed.fitToMesh && fit ? [...fit.max] : [...parsed.boundsMax];
  return { ...parsed, cageMin: min, cageMax: max, preview };
}

function restPosition(body: DeformerHandleBody, x: number, y: number, z: number): ShapePoint {
  const grid = [x, y, z];
  return [0, 1, 2].map((axis) => {
    const size = Math.max(MIN_CAGE_SIZE, body.cageMax[axis]! - body.cageMin[axis]!);
    const centre = (body.cageMin[axis]! + body.cageMax[axis]!) / 2;
    return centre - size / 2 + size * (grid[axis]! / (body.resolution[axis]! - 1));
  }) as ShapePoint;
}

function gridOf(body: DeformerHandleBody, index: number): [number, number, number] {
  const [rx, ry] = body.resolution;
  return [index % rx, Math.floor(index / rx) % ry, Math.floor(index / (rx * ry))];
}

/** One handle per control at its rest position plus its authored offset (Strength is not applied). */
export function deformerHandles(body: DeformerHandleBody): DeformerHandle[] {
  const [rx, ry, rz] = body.resolution;
  const handles: DeformerHandle[] = [];
  for (let index = 0; index < rx * ry * rz; index++) {
    const rest = restPosition(body, ...gridOf(body, index));
    const position = rest.map((value, axis) => value + body.offsets[index * 3 + axis]!) as ShapePoint;
    handles.push({ id: `point:${index}`, kind: "point", position, index });
  }
  return handles;
}

/** Cage edges between neighbouring controls along each axis. */
export function deformerOutline(body: DeformerHandleBody): ShapePoint[][] {
  const [rx, ry, rz] = body.resolution;
  const points = deformerHandles(body).map((handle) => handle.position);
  const at = (x: number, y: number, z: number) => points[x + rx * (y + ry * z)]!;
  const lines: ShapePoint[][] = [];
  for (let z = 0; z < rz; z++) for (let y = 0; y < ry; y++) lines.push(Array.from({ length: rx }, (_, x) => at(x, y, z)));
  for (let z = 0; z < rz; z++) for (let x = 0; x < rx; x++) lines.push(Array.from({ length: ry }, (_, y) => at(x, y, z)));
  for (let y = 0; y < ry; y++) for (let x = 0; x < rx; x++) lines.push(Array.from({ length: rz }, (_, z) => at(x, y, z)));
  return lines;
}

export function dragDeformerHandle(body: DeformerHandleBody, index: number, local: ShapePoint): { offsets: number[] } {
  const rest = restPosition(body, ...gridOf(body, index));
  const offsets = [...body.offsets];
  for (let axis = 0; axis < 3; axis++) offsets[index * 3 + axis] = local[axis]! - rest[axis]!;
  return { offsets };
}

export function resetDeformerHandle(body: DeformerHandleBody, index: number): { offsets: number[] } | null {
  if ([0, 1, 2].every((axis) => body.offsets[index * 3 + axis] === 0)) return null;
  const offsets = [...body.offsets];
  offsets.fill(0, index * 3, index * 3 + 3);
  return { offsets };
}

const sameFit = (body: DeformerHandleBody, fit: { min: Vector3; max: Vector3 }) =>
  [0, 1, 2].every((axis) => body.cageMin[axis] === fit.min.asArray()[axis] && body.cageMax[axis] === fit.max.asArray()[axis]);

/**
 * Lattice controls of a Deformer on its target Mesh. Points move in the camera-facing
 * plane like Spline points; a selected point takes the translate gizmo. Double-clicking
 * a point resets its offset. Drags preview on the mesh and commit once on release.
 */
export function createDeformerHandles(layer: UtilityLayerRenderer, scene: Scene, options: ShapeHandlesOptions = {}): ShapeHandlesHost<DeformerHandleTarget> {
  const fitOf = (target: DeformerHandleTarget) => {
    const mesh = target.resolveMesh?.() ?? null;
    const fit = mesh ? latticeFitBounds(mesh) : null;
    return fit ? { min: fit.min.asArray() as ShapePoint, max: fit.max.asArray() as ShapePoint } : null;
  };
  return createShapeHandles<DeformerHandleBody, DeformerHandle, DeformerHandleTarget>(layer, scene, {
    name: "deformer",
    parse: (properties, target) => {
      const source = properties as Partial<DeformerHandleBody>;
      // Preview edits re-parse the current body; keep its cage box instead of refitting per move.
      const fit = source.cageMin && source.cageMax ? { min: source.cageMin, max: source.cageMax } : fitOf(target);
      return deformerHandleBody(properties, fit, target.preview);
    },
    // An asynchronously loaded model or a geometry change moves the fitted cage.
    read: (mesh, current) => {
      if (!current.fitToMesh) return null;
      const fit = latticeFitBounds(mesh);
      if (!fit || sameFit(current, fit)) return null;
      return { ...current, cageMin: fit.min.asArray() as ShapePoint, cageMax: fit.max.asArray() as ShapePoint };
    },
    update: (mesh, body) => {
      if (!body.preview) return;
      // A material without a lattice adapter keeps the committed result; the handles still move.
      try { setMeshLatticeDeformer(mesh, body); } catch { /* reported by the committed scene sync */ }
    },
    handles: deformerHandles,
    outline: deformerOutline,
    drag: (body, handle, local) => dragDeformerHandle(body, handle.index, local),
    insert: () => null,
    remove: (body, handle) => resetDeformerHandle(body, handle.index),
    constraint: (_handle, _world, camera) => ({ dragPlaneNormal: camera ? cameraForward(camera) : FALLBACK_FORWARD }),
    color: () => POINT_COLOR,
    selectable: () => true,
  }, options);
}
