import { Color3, Vector3, type Scene, type UtilityLayerRenderer } from "@babylonjs/core";
import {
  normalizeWaterBody, waterRiverCentreline, WATER_RIVER_SUBDIVISIONS,
  type WaterBodyProperties, type WaterKind,
} from "@babylonslate/core";
import { GIZMO_AXIS_COLORS } from "./gizmo-host";
import { createShapeHandles, type ShapeHandlesOptions, type ShapeHandlesHost } from "./shape-handles";
import { updateWaterMeshBody, waterMeshBody } from "./water-mesh";
type Vec3 = [number, number, number];

/** Editable water properties; a commit merges them into the component. */
export type WaterShapeEdit = Partial<Pick<WaterBodyProperties, "width" | "length" | "depth" | "points" | "widthScales">>;

export type WaterHandleKind = "size" | "depth" | "point" | "pointWidth" | "insert";
export interface WaterHandle {
  id: string;
  kind: WaterHandleKind;
  /** Component-local position. */
  position: Vec3;
  /** River control-point index; for `insert`, the upstream point of the segment. */
  index?: number;
}

const MIN_SIZE = 0.1;
const MIN_DEPTH = 0.01;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function riverTangent(body: WaterBodyProperties, index: number): [number, number] {
  const line = waterRiverCentreline(body);
  const steps = line.length === body.points.length ? 1 : WATER_RIVER_SUBDIVISIONS;
  const at = index * steps;
  const a = line[Math.max(0, at - 1)]!, b = line[Math.min(line.length - 1, at + 1)]!;
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
  return [dx / length, dz / length];
}

/** Handles for a water body, in the component's local space. Global Water Volume only edits Depth. */
export function waterHandles(body: WaterBodyProperties): WaterHandle[] {
  const depth: WaterHandle = { id: "depth", kind: "depth", position: [0, -body.depth, 0] };
  if (body.kind === "global") return [depth];
  if (body.kind !== "river") {
    const w = body.width / 2, l = body.length / 2;
    return [
      { id: "width+", kind: "size", position: [w, 0, 0] },
      { id: "width-", kind: "size", position: [-w, 0, 0] },
      { id: "length+", kind: "size", position: [0, 0, l] },
      { id: "length-", kind: "size", position: [0, 0, -l] },
      depth,
    ];
  }
  const handles: WaterHandle[] = [];
  const line = waterRiverCentreline(body);
  const steps = line.length === body.points.length ? 1 : WATER_RIVER_SUBDIVISIONS;
  body.points.forEach((point, index) => {
    handles.push({ id: `point:${index}`, kind: "point", position: [...point], index });
    const [tx, tz] = riverTangent(body, index), half = body.width * body.widthScales[index]! / 2;
    handles.push({ id: `pointWidth:${index}`, kind: "pointWidth", position: [point[0] - tz * half, point[1], point[2] + tx * half], index });
    if (index < body.points.length - 1) {
      const middle = (index + 0.5) * steps, a = line[Math.floor(middle)]!, b = line[Math.ceil(middle)]!;
      handles.push({ id: `insert:${index}`, kind: "insert", position: [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2], index });
    }
  });
  return handles;
}

/** Property changes for dragging a handle to a component-local point. Sizes stay centred. */
export function dragWaterHandle(body: WaterBodyProperties, handle: WaterHandle, local: Vec3): WaterShapeEdit {
  if (handle.kind === "depth") return { depth: clamp(-local[1], MIN_DEPTH, 10000) };
  if (handle.kind === "size") {
    return handle.id.startsWith("width")
      ? { width: clamp(Math.abs(local[0]) * 2, MIN_SIZE, 10000) }
      : { length: clamp(Math.abs(local[2]) * 2, MIN_SIZE, 10000) };
  }
  const index = handle.index ?? 0;
  if (handle.kind === "point") {
    return { points: body.points.map((point, i) => i === index ? [local[0], point[1], local[2]] : [...point]) };
  }
  if (handle.kind === "pointWidth") {
    const point = body.points[index]!, [tx, tz] = riverTangent(body, index);
    const half = Math.abs((local[0] - point[0]) * -tz + (local[2] - point[2]) * tx);
    return { widthScales: body.widthScales.map((scale, i) => i === index ? clamp(half * 2 / body.width, 0.05, 20) : scale) };
  }
  return {};
}

/** Insert a river point after `index`, at a local position, with an interpolated elevation and width. */
export function insertRiverPoint(body: WaterBodyProperties, index: number, local: Vec3): WaterShapeEdit {
  const a = body.points[index]!, b = body.points[index + 1] ?? a;
  const point: Vec3 = [local[0], (a[1] + b[1]) / 2, local[2]];
  const scale = ((body.widthScales[index] ?? 1) + (body.widthScales[index + 1] ?? 1)) / 2;
  return {
    points: [...body.points.slice(0, index + 1).map((p) => [...p] as Vec3), point, ...body.points.slice(index + 1).map((p) => [...p] as Vec3)],
    widthScales: [...body.widthScales.slice(0, index + 1), scale, ...body.widthScales.slice(index + 1)],
  };
}

/** Remove a river point; a river keeps at least two. */
export function removeRiverPoint(body: WaterBodyProperties, index: number): WaterShapeEdit | null {
  if (body.points.length <= 2) return null;
  return {
    points: body.points.filter((_, i) => i !== index).map((p) => [...p] as Vec3),
    widthScales: body.widthScales.filter((_, i) => i !== index),
  };
}

/** Local outline polylines: bounds for finite volumes; banks and centreline for rivers. */
export function waterOutline(body: WaterBodyProperties): Vec3[][] {
  if (body.kind === "global") return [];
  if (body.kind === "ocean") {
    const w = body.width / 2, l = body.length / 2;
    return [[[-w, 0, -l], [w, 0, -l], [w, 0, l], [-w, 0, l], [-w, 0, -l]]];
  }
  if (body.kind !== "river") {
    return [Array.from({ length: 65 }, (_, i) => {
      const angle = i / 64 * Math.PI * 2;
      return [Math.cos(angle) * body.width / 2, 0, Math.sin(angle) * body.length / 2] as Vec3;
    })];
  }
  const line = waterRiverCentreline(body);
  const side = (sign: number) => line.map((p, i) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
    return [p.x - dz / length * p.halfWidth * sign, p.y, p.z + dx / length * p.halfWidth * sign] as Vec3;
  });
  return [side(1), side(-1), line.map((p) => [p.x, p.y, p.z] as Vec3)];
}

export interface WaterHandleTarget {
  actorId: string;
  componentId: string;
  kind: WaterKind;
  /** Main-scene water mesh name; resolved each frame so a rebuilt mesh is followed. */
  meshName: string;
  properties: Record<string, unknown>;
}

export type WaterHandlesOptions = ShapeHandlesOptions;
export type WaterHandlesHost = ShapeHandlesHost<WaterHandleTarget>;

const POINT_COLOR = new Color3(0.95, 0.97, 1);
const WIDTH_COLOR = new Color3(0.98, 0.62, 0.2);
const BODY_KEYS = ["kind", "assetGuid", "enabled", "width", "length", "depth", "waveScale", "flowSpeed", "flowDirection", "points", "widthScales", "curvature", "resolution"] as const;

/** Water-specific geometry and constraints use the shared component shape editor. */
export function createWaterHandles(layer: UtilityLayerRenderer, scene: Scene, options: WaterHandlesOptions = {}): WaterHandlesHost {
  let lastRead: WaterBodyProperties | null = null;
  return createShapeHandles<WaterBodyProperties, WaterHandle, WaterHandleTarget>(layer, scene, {
    name: "water",
    parse: (properties, target) => normalizeWaterBody(properties, target.kind),
    read: (mesh) => {
      const live = waterMeshBody(mesh);
      if (!live) { lastRead = null; return null; }
      // Water's renderer mutates its body in place; give the shared host a stable snapshot per edit.
      let changed = lastRead === null;
      if (lastRead) for (const key of BODY_KEYS) if (live[key] !== lastRead[key]) { changed = true; break; }
      if (changed) lastRead = { ...live };
      return lastRead;
    },
    update: (mesh, body) => { updateWaterMeshBody(mesh, body); },
    handles: waterHandles,
    outline: (body) => {
      const lines = waterOutline(body);
      if (body.kind !== "river") lines.push([[0, 0, 0], [0, -body.depth, 0]]);
      return lines;
    },
    drag: dragWaterHandle,
    insert: (body, handle, local) => {
      const index = handle.index ?? 0;
      return { properties: insertRiverPoint(body, index, local), handle: { id: `point:${index + 1}`, kind: "point", position: local, index: index + 1 } };
    },
    remove: (body, handle) => removeRiverPoint(body, handle.index ?? 0),
    constraint: (handle, world) => {
      const up = Vector3.TransformNormal(Vector3.Up(), world).normalize();
      return handle.kind === "depth" ? { dragAxis: up } : { dragPlaneNormal: up };
    },
    color: (handle) => handle.kind === "pointWidth" ? WIDTH_COLOR
      : handle.kind === "depth" ? GIZMO_AXIS_COLORS.y
      : handle.kind === "size" ? (handle.id.startsWith("length") ? GIZMO_AXIS_COLORS.z : GIZMO_AXIS_COLORS.x)
      : POINT_COLOR,
  }, options);
}
