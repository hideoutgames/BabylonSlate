import {
  Camera,
  Color3,
  CreateLineSystem,
  CreateSphere,
  Mesh,
  PointerDragBehavior,
  Quaternion,
  StandardMaterial,
  Vector3,
  type LinesMesh,
  type Scene,
  type UtilityLayerRenderer,
} from "@babylonjs/core";
import {
  normalizeWaterBody,
  waterRiverCentreline,
  WATER_RIVER_SUBDIVISIONS,
  type WaterBodyProperties,
  type WaterKind,
} from "@babylonslate/core";
import { GIZMO_AXIS_COLORS } from "./gizmo-host";
import type { RenderScheduler } from "./render-scheduler";
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

export interface WaterHandlesOptions {
  scheduler?: Pick<RenderScheduler, "invalidate" | "acquireContinuous">;
  /** Screen-space handle scale; touch needs larger handles than a mouse. */
  handleScale?: number;
  onDragStart?: () => void;
  onCommit?: (edit: { actorId: string; componentId: string; properties: Record<string, unknown> }) => void;
}

export interface WaterHandlesHost {
  attach: (target: WaterHandleTarget | null) => void;
  isDragging: () => boolean;
  /** Current handles for tests and diagnostics. */
  handleIds: () => string[];
  dispose: () => void;
}

const DOUBLE_TAP_MS = 350;
const POINT_COLOR = new Color3(0.95, 0.97, 1);
const WIDTH_COLOR = new Color3(0.98, 0.62, 0.2);
const OUTLINE_COLOR = new Color3(0.42, 0.78, 1);

function unlit(name: string, scene: Scene, color: Color3, alpha = 1): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.emissiveColor = color.clone();
  material.diffuseColor = color.clone();
  material.specularColor = Color3.Black();
  material.alpha = alpha;
  return material;
}

/**
 * Viewport shape handles for the selected water component, drawn on the gizmo utility
 * layer. Drags reshape the mesh live and commit one property change when released.
 */
export function createWaterHandles(layer: UtilityLayerRenderer, scene: Scene, options: WaterHandlesOptions = {}): WaterHandlesHost {
  const util = layer.utilityLayerScene;
  const materials = {
    point: unlit("water-handle-point", util, POINT_COLOR),
    pointWidth: unlit("water-handle-width", util, WIDTH_COLOR),
    insert: unlit("water-handle-insert", util, POINT_COLOR, 0.45),
    size: unlit("water-handle-size", util, GIZMO_AXIS_COLORS.x),
    sizeZ: unlit("water-handle-size-z", util, GIZMO_AXIS_COLORS.z),
    depth: unlit("water-handle-depth", util, GIZMO_AXIS_COLORS.y),
  };
  const handleScale = options.handleScale ?? 1;
  let target: WaterHandleTarget | null = null;
  let body: WaterBodyProperties | null = null;
  let handles: WaterHandle[] = [];
  const meshes = new Map<string, Mesh>();
  let outline: LinesMesh | null = null;
  let outlineKey = "";
  let drag: { handle: WaterHandle; start: WaterBodyProperties; edit: WaterShapeEdit; cancelled: boolean } | null = null;
  let release: (() => void) | null = null;
  const lastTap = { id: "", time: 0 };

  const waterMesh = (): Mesh | null => {
    if (!target) return null;
    const mesh = scene.getMeshByName(target.meshName);
    return mesh instanceof Mesh && !mesh.isDisposed() ? mesh : null;
  };
  const world = () => waterMesh()?.computeWorldMatrix(true) ?? null;
  const toLocal = (point: Vector3): Vec3 | null => {
    const matrix = world();
    if (!matrix || Math.abs(matrix.determinant()) < 1e-12) return null;
    return Vector3.TransformCoordinates(point, matrix.clone().invert()).asArray() as Vec3;
  };

  const clearMeshes = () => {
    for (const mesh of meshes.values()) mesh.dispose(false, false);
    meshes.clear();
    outline?.dispose(); outline = null; outlineKey = "";
  };

  const apply = (edit: WaterShapeEdit) => {
    if (!body) return;
    const next = normalizeWaterBody({ ...body, ...edit }, body.kind);
    const mesh = waterMesh();
    if (mesh) updateWaterMeshBody(mesh, next);
    body = next;
    options.scheduler?.invalidate("gizmo");
  };

  const finish = () => {
    const current = drag;
    drag = null;
    release?.(); release = null;
    options.scheduler?.invalidate("gizmo");
    if (!current || !target || current.cancelled || Object.keys(current.edit).length === 0) return;
    options.onCommit?.({ actorId: target.actorId, componentId: target.componentId, properties: { ...target.properties, ...current.edit } });
  };

  const bind = (mesh: Mesh, handleId: string) => {
    const behavior = new PointerDragBehavior({ dragPlaneNormal: Vector3.Up() });
    behavior.moveAttached = false;
    behavior.useObjectOrientationForDragging = false;
    behavior.updateDragPlane = false;
    mesh.addBehavior(behavior, true);
    behavior.onDragStartObservable.add(() => {
      const handle = handles.find((entry) => entry.id === handleId);
      if (!handle || !body) return;
      const now = performance.now();
      const doubleTap = lastTap.id === handleId && now - lastTap.time < DOUBLE_TAP_MS;
      lastTap.id = handleId; lastTap.time = now;
      release ??= options.scheduler?.acquireContinuous("water-handles") ?? null;
      options.onDragStart?.();
      drag = { handle, start: body, edit: {}, cancelled: false };
      if (doubleTap && handle.kind === "point") {
        const removal = removeRiverPoint(body, handle.index ?? 0);
        if (removal) { drag.edit = removal; apply(removal); }
        drag.handle = { ...handle, kind: "size", id: "removed" };
        lastTap.id = "";
      }
    });
    behavior.onDragObservable.add((event) => {
      if (!drag || !body || drag.handle.id === "removed") return;
      const local = toLocal(event.dragPlanePoint);
      if (!local) return;
      if (drag.handle.kind === "insert") {
        const index = drag.handle.index ?? 0;
        const inserted = insertRiverPoint(body, index, local);
        apply(inserted);
        drag.edit = { ...drag.edit, ...inserted };
        drag.handle = { id: `point:${index + 1}`, kind: "point", position: local, index: index + 1 };
        return;
      }
      const edit = dragWaterHandle(body, drag.handle, local);
      drag.edit = { ...drag.edit, ...edit };
      apply(edit);
    });
    behavior.onDragEndObservable.add(finish);
    return behavior;
  };

  const rebuild = () => {
    clearMeshes();
    if (!body) return;
    handles = waterHandles(body);
    for (const handle of handles) {
      const pick = CreateSphere(`water-handle:${handle.id}`, { diameter: 1, segments: 8 }, util);
      pick.visibility = 0;
      pick.isPickable = true;
      const visual = CreateSphere(`water-handle:${handle.id}:visual`, { diameter: handle.kind === "insert" ? 0.32 : 0.45, segments: 12 }, util);
      visual.isPickable = false;
      visual.parent = pick;
      visual.material = handle.kind === "size" ? (handle.id.startsWith("length") ? materials.sizeZ : materials.size) : materials[handle.kind];
      bind(pick, handle.id);
      meshes.set(handle.id, pick);
    }
  };

  const layout = () => {
    const mesh = waterMesh();
    if (!target || !mesh) { for (const entry of meshes.values()) entry.setEnabled(false); outline?.setEnabled(false); return; }
    // The mesh owns the live shape; it is replaced when a committed edit rebuilds the component.
    const live = waterMeshBody(mesh);
    if (!drag && live) body = live as WaterBodyProperties;
    if (!body) return;
    const next = waterHandles(body);
    if (next.length !== handles.length || next.some((handle, i) => handle.id !== handles[i]?.id)) rebuild();
    handles = next;
    const matrix = mesh.computeWorldMatrix(true);
    const camera = layer.getRenderCamera();
    const up = Vector3.TransformNormal(Vector3.Up(), matrix).normalize();
    for (const handle of handles) {
      const pick = meshes.get(handle.id);
      if (!pick) continue;
      pick.setEnabled(true);
      const position = Vector3.TransformCoordinates(Vector3.FromArray(handle.position), matrix);
      pick.position.copyFrom(position);
      const distance = camera ? Vector3.Distance(camera.globalPosition, position) : 10;
      const ortho = camera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? (camera.orthoTop ?? 1) - (camera.orthoBottom ?? -1) : 0;
      pick.scaling.setAll(Math.max(0.01, (ortho || distance) * 0.045 * handleScale));
      const behavior = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior | null;
      if (behavior && !drag) behavior.options = handle.kind === "depth" ? { dragAxis: up } : { dragPlaneNormal: up };
    }
    const key = JSON.stringify(body) + Array.from(matrix.m).join(",");
    if (key !== outlineKey) {
      outline?.dispose();
      const lines = waterOutline(body).map((line) => line.map((p) => Vector3.FromArray(p)));
      if (handles.some((handle) => handle.kind === "depth")) lines.push([Vector3.Zero(), new Vector3(0, -body.depth, 0)]);
      outline = CreateLineSystem("water-handle-outline", { lines }, util);
      outline.color = OUTLINE_COLOR;
      outline.isPickable = false;
      const scaling = new Vector3(), rotation = new Quaternion(), position = new Vector3();
      matrix.decompose(scaling, rotation, position);
      outline.scaling.copyFrom(scaling); outline.rotationQuaternion = rotation; outline.position.copyFrom(position);
      outlineKey = key;
    }
    outline?.setEnabled(true);
  };

  const observer = util.onBeforeRenderObservable.add(layout);

  return {
    attach: (next) => {
      const same = next && target && next.actorId === target.actorId && next.componentId === target.componentId && next.meshName === target.meshName;
      if (drag && same) { target = next; return; }
      if (drag) { drag.cancelled = true; finish(); }
      target = next;
      body = next ? normalizeWaterBody(next.properties, next.kind) : null;
      if (!same) { handles = []; clearMeshes(); }
      if (next) layout();
      options.scheduler?.invalidate("gizmo");
    },
    isDragging: () => drag !== null,
    handleIds: () => handles.map((handle) => handle.id),
    dispose: () => {
      util.onBeforeRenderObservable.remove(observer);
      if (drag) { drag.cancelled = true; finish(); }
      clearMeshes();
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
