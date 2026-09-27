import {
  Camera, Color3, CreateLineSystem, CreateSphere, Mesh, PointerDragBehavior,
  StandardMaterial, Vector3,
  type LinesMesh, type Matrix, type Scene, type UtilityLayerRenderer,
} from "@babylonjs/core";
import type { RenderScheduler } from "./render-scheduler";

export type ShapePoint = [number, number, number];
export interface ShapeHandle {
  id: string;
  kind: string;
  position: ShapePoint;
  index?: number;
}
export interface ComponentShapeEdit {
  actorId: string;
  componentId: string;
  properties: Record<string, unknown>;
}
export interface ShapeHandleTarget extends ComponentShapeEdit { meshName: string }
export interface ShapeHandlesOptions {
  scheduler?: Pick<RenderScheduler, "invalidate" | "acquireContinuous">;
  handleScale?: number;
  onDragStart?: () => void;
  onCommit?: (edit: ComponentShapeEdit) => void;
}
export interface ShapeHandlesHost<Target extends ShapeHandleTarget> {
  attach: (target: Target | null) => void;
  isDragging: () => boolean;
  handleIds: () => string[];
  dispose: () => void;
}
export interface ShapeHandlesAdapter<Body extends object, Handle extends ShapeHandle, Target extends ShapeHandleTarget> {
  name: string;
  parse: (properties: unknown, target: Target) => Body;
  read: (mesh: Mesh) => Body | null;
  update: (mesh: Mesh, body: Body) => void;
  handles: (body: Body) => Handle[];
  outline: (body: Body) => ShapePoint[][];
  drag: (body: Body, handle: Handle, local: ShapePoint) => Record<string, unknown>;
  insert: (body: Body, handle: Handle, local: ShapePoint) => { properties: Record<string, unknown>; handle: Handle } | null;
  remove: (body: Body, handle: Handle) => Record<string, unknown> | null;
  constraint: (handle: Handle, world: Matrix, camera: Camera | null) => { dragAxis: Vector3 } | { dragPlaneNormal: Vector3 };
  color: (handle: Handle) => Color3;
}

const OUTLINE_COLOR = new Color3(0.42, 0.78, 1);

/** Shared water/spline handle lifecycle. Preview edits stay local until one release commit. */
export function createShapeHandles<Body extends object, Handle extends ShapeHandle, Target extends ShapeHandleTarget>(
  layer: UtilityLayerRenderer, scene: Scene,
  adapter: ShapeHandlesAdapter<Body, Handle, Target>, options: ShapeHandlesOptions = {},
): ShapeHandlesHost<Target> {
  const util = layer.utilityLayerScene;
  const meshes = new Map<string, Mesh>();
  const materials = new Map<string, StandardMaterial>();
  let target: Target | null = null;
  let body: Body | null = null;
  let handles: Handle[] = [];
  let outline: LinesMesh | null = null;
  let outlineKey = "";
  let drag: { handle: Handle; meshId: string; start: Body; properties: Record<string, unknown>; removed: boolean } | null = null;
  let release: (() => void) | null = null;
  const lastTap = { id: "", time: -Infinity };
  const sourceMesh = (): Mesh | null => {
    const mesh = target ? scene.getMeshByName(target.meshName) : null;
    return mesh instanceof Mesh && !mesh.isDisposed() ? mesh : null;
  };
  const clear = () => {
    for (const mesh of meshes.values()) mesh.dispose(false, false);
    meshes.clear();
    outline?.dispose(); outline = null; outlineKey = "";
  };
  const apply = (properties: Record<string, unknown>) => {
    if (!body || !target) return;
    body = adapter.parse({ ...body, ...properties }, target);
    const mesh = sourceMesh();
    if (mesh) adapter.update(mesh, body);
    options.scheduler?.invalidate("gizmo");
  };
  const finish = (cancelled = false) => {
    const current = drag;
    drag = null;
    release?.(); release = null;
    if (cancelled && current) {
      body = current.start;
      const mesh = sourceMesh();
      if (mesh) adapter.update(mesh, body);
    }
    options.scheduler?.invalidate("gizmo");
    if (!current || !target || cancelled || Object.keys(current.properties).length === 0) return;
    options.onCommit?.({ actorId: target.actorId, componentId: target.componentId, properties: { ...target.properties, ...current.properties } });
  };
  const bind = (mesh: Mesh, id: string) => {
    const behavior = new PointerDragBehavior({ dragPlaneNormal: Vector3.Up() });
    behavior.moveAttached = false;
    behavior.useObjectOrientationForDragging = false;
    behavior.updateDragPlane = false;
    mesh.addBehavior(behavior, true);
    behavior.onDragStartObservable.add(() => {
      const handle = handles.find((entry) => entry.id === id);
      if (!handle || !body || !target) return;
      const now = performance.now();
      const doubleTap = lastTap.id === id && now - lastTap.time < 350;
      lastTap.id = id; lastTap.time = now;
      release ??= options.scheduler?.acquireContinuous(`${adapter.name}-handles`) ?? null;
      options.onDragStart?.();
      drag = { handle, meshId: id, start: adapter.parse({ ...body }, target), properties: {}, removed: false };
      if (doubleTap && handle.kind === "point") {
        const removal = adapter.remove(body, handle);
        if (removal) { drag.properties = removal; drag.removed = true; apply(removal); }
        lastTap.id = "";
      }
    });
    behavior.onDragObservable.add((event) => {
      if (!drag || !body || drag.removed) return;
      lastTap.id = "";
      const matrix = sourceMesh()?.computeWorldMatrix(true);
      if (!matrix || Math.abs(matrix.determinant()) < 1e-12) return;
      const local = Vector3.TransformCoordinates(event.dragPlanePoint, matrix.clone().invert()).asArray() as ShapePoint;
      if (drag.handle.kind === "insert") {
        const inserted = adapter.insert(body, drag.handle, local);
        if (!inserted) return;
        drag.handle = inserted.handle;
        drag.properties = { ...drag.properties, ...inserted.properties };
        apply(inserted.properties);
      } else {
        const properties = adapter.drag(body, drag.handle, local);
        drag.properties = { ...drag.properties, ...properties };
        apply(properties);
      }
    });
    behavior.onDragEndObservable.add(() => finish());
  };
  const syncMeshes = () => {
    const ids = new Set(handles.map((handle) => handle.id));
    for (const [id, mesh] of meshes) {
      if (ids.has(id)) continue;
      if (drag?.meshId === id) { mesh.setEnabled(false); continue; }
      mesh.dispose(false, false); meshes.delete(id);
    }
    for (const handle of handles) {
      if (meshes.has(handle.id)) continue;
      const pick = CreateSphere(`${adapter.name}-handle:${handle.id}`, { diameter: 1, segments: 8 }, util);
      pick.visibility = 0; pick.isPickable = true;
      const visual = CreateSphere(`${adapter.name}-handle:${handle.id}:visual`, { diameter: handle.kind === "insert" ? 0.32 : 0.45, segments: 12 }, util);
      visual.isPickable = false; visual.parent = pick;
      const color = adapter.color(handle), alpha = handle.kind === "insert" ? 0.45 : 1;
      const key = `${color.toHexString()}:${alpha}`;
      let material = materials.get(key);
      if (!material) {
        material = new StandardMaterial(`${adapter.name}-handle:${key}`, util);
        material.disableLighting = true; material.emissiveColor = color.clone();
        material.diffuseColor = color.clone(); material.specularColor = Color3.Black(); material.alpha = alpha;
        materials.set(key, material);
      }
      visual.material = material;
      bind(pick, handle.id); meshes.set(handle.id, pick);
    }
  };
  const layout = () => {
    const source = sourceMesh();
    if (!target || !source || !source.isEnabled() || !source.isVisible) {
      for (const mesh of meshes.values()) mesh.setEnabled(false);
      outline?.setEnabled(false); return;
    }
    if (!drag) body = adapter.read(source) ?? body;
    if (!body) return;
    handles = adapter.handles(body); syncMeshes();
    const matrix = source.computeWorldMatrix(true), camera = layer.getRenderCamera();
    for (const handle of handles) {
      const pick = meshes.get(handle.id)!;
      pick.setEnabled(true);
      const position = Vector3.TransformCoordinates(Vector3.FromArray(handle.position), matrix);
      pick.position.copyFrom(position);
      const distance = camera ? Vector3.Distance(camera.globalPosition, position) : 10;
      const ortho = camera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? (camera.orthoTop ?? 1) - (camera.orthoBottom ?? -1) : 0;
      pick.scaling.setAll(Math.max(0.01, (ortho || distance) * 0.045 * (options.handleScale ?? 1)));
      const behavior = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior | null;
      if (behavior && !drag) behavior.options = adapter.constraint(handle, matrix, camera);
    }
    const key = JSON.stringify(body) + Array.from(matrix.m).join(",");
    if (key !== outlineKey) {
      outline?.dispose(); outline = null;
      const lines = adapter.outline(body).map((line) => line.map((point) => Vector3.TransformCoordinates(Vector3.FromArray(point), matrix)));
      if (lines.length) {
        outline = CreateLineSystem(`${adapter.name}-handle-outline`, { lines }, util);
        outline.color = OUTLINE_COLOR; outline.isPickable = false;
      }
      outlineKey = key;
    }
    outline?.setEnabled(true);
  };
  const observer = util.onBeforeRenderObservable.add(layout);
  return {
    attach: (next) => {
      const same = next && target && next.actorId === target.actorId && next.componentId === target.componentId && next.meshName === target.meshName;
      if (drag && same) { target = next; return; }
      if (drag) finish(true);
      target = next; body = next ? adapter.parse(next.properties, next) : null;
      if (!same) { handles = []; clear(); lastTap.id = ""; }
      if (next) layout();
      options.scheduler?.invalidate("gizmo");
    },
    isDragging: () => drag !== null,
    handleIds: () => handles.map((handle) => handle.id),
    dispose: () => {
      util.onBeforeRenderObservable.remove(observer);
      if (drag) finish(true);
      clear();
      for (const material of materials.values()) material.dispose();
    },
  };
}
