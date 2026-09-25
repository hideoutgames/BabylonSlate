import { Color4, Matrix, Mesh, MeshBuilder, Quaternion, Ray, Vector3, type AbstractMesh, type LinesMesh } from "@babylonjs/core";
import { appendFoliageInstance, chooseFoliageModel, createActor, identitySerializedTransform, parseFoliageProperties, parseLandscapeProperties, sculptLandscape, type FoliageGroup, type FoliageProperties, type LandscapeBrush, type SerializedScene } from "@babylonslate/core";
import type { EngineHandle } from "./create-engine";
import { freezeEditorActiveMeshes } from "./scene-perf";
import { RENDERING_GROUP } from "./sorting";

export interface SceneBrushState {
  scene: SerializedScene | null;
  mode: "design" | "landscape" | "foliage";
  enabled: boolean;
  landscapeSelection: string | null;
  landscapeTool: LandscapeBrush["tool"] | "navigate";
  landscapeBrush: LandscapeBrush;
  foliageTool: "navigate" | "paint" | "erase";
  foliageBrush: { radius: number; density: number; spacing: number; maxSlope: number; alignToNormal: boolean; randomYaw: boolean };
  group: FoliageGroup | undefined;
}

const RING_SEGMENTS = 48;
const RING_LIFT = 0.03;
const RING_COLOR = new Color4(0.95, 0.65, 0.2, 1);
const RING_INNER_COLOR = new Color4(0.95, 0.65, 0.2, 0.5);

type Stroke = { pointerId: number; before: SerializedScene; next: SerializedScene; state: SceneBrushState; last: Vector3 | null; foliage: FoliageProperties; actorId: string; componentId: string; occupied: Map<string, Vector3[]> };

function alignment(normal: Vector3): Quaternion {
  const axis = Vector3.Cross(Vector3.Up(), normal);
  return axis.lengthSquared() < 1e-10 ? Quaternion.Identity() : Quaternion.RotationAxis(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, normal.y))));
}

/** Capture painting before camera input. Navigate restores the ordinary desktop/touch gestures. */
export function attachSceneBrushInput(handle: EngineHandle, canvas: HTMLCanvasElement, options: {
  getState(): SceneBrushState;
  commit(next: SerializedScene, before: SerializedScene): Promise<boolean>;
  onError?(error: unknown): void;
  random?: () => number;
}): () => void {
  let stroke: Stroke | null = null;
  let ring: LinesMesh | null = null;
  let pending = false;
  const pointers = new Set<number>();
  const random = options.random ?? Math.random;
  const enabled = (state: SceneBrushState) => state.enabled && state.mode !== "design" &&
    (state.mode === "landscape" ? state.landscapeTool !== "navigate" : state.foliageTool !== "navigate");
  const radiusOf = (state: SceneBrushState) => state.mode === "landscape" ? state.landscapeBrush.radius : state.foliageBrush.radius;
  const actorFor = (mesh: AbstractMesh) => {
    for (let node: AbstractMesh | null = mesh; node; node = node.parent as AbstractMesh | null) {
      const id = handle.editor?.sync.actorForMesh(node.name);
      if (id) return id;
    }
    return null;
  };
  const predicate = (state: SceneBrushState) => (mesh: AbstractMesh) => {
    if (!mesh.isVisible || !mesh.isEnabled() || !mesh.isPickable || !mesh.getTotalVertices() || mesh.metadata?.foliageRoot) return false;
    const actorId = actorFor(mesh);
    const actor = state.scene?.actors.find((entry) => entry.id === actorId);
    if (!actor || !actor.visible || actor.locked) return false;
    if (state.mode === "foliage") return true;
    const root = mesh.metadata?.landscapeRoot as Mesh | undefined;
    return Boolean(root && actor.components.some((component) => component.classId === "LandscapeComponent" &&
      `${actor.id}/${component.id}` === state.landscapeSelection && handle.editor?.sync.meshForComponent(actor.id, component.id) === root));
  };
  const pick = (event: PointerEvent, state: SceneBrushState) => {
    const rect = canvas.getBoundingClientRect();
    return handle.scene.pick(event.clientX - rect.left, event.clientY - rect.top, predicate(state));
  };
  const hideRing = () => {
    if (!ring) return;
    ring.dispose(); ring = null;
    freezeEditorActiveMeshes(handle.scene);
    handle.scheduler.invalidate("manual");
  };
  const showRing = (point: Vector3, normal: Vector3, state: SceneBrushState) => {
    const radius = radiusOf(state);
    const rotation = Matrix.Identity();
    alignment(normal).toRotationMatrix(rotation);
    const lift = Math.max(1, radius);
    const surface = predicate(state);
    // The foreground group keeps world depth, so a flat circle would sink into sculpted relief.
    const circle = (circleRadius: number) => Array.from({ length: RING_SEGMENTS + 1 }, (_, i) => {
      const angle = i / RING_SEGMENTS * Math.PI * 2;
      const planar = Vector3.TransformCoordinates(new Vector3(Math.cos(angle) * circleRadius, 0, Math.sin(angle) * circleRadius), rotation).add(point);
      const hit = handle.scene.pickWithRay(new Ray(planar.add(normal.scale(lift)), normal.negate(), lift * 2), surface);
      return (hit?.pickedPoint ?? planar).add(normal.scale(RING_LIFT));
    });
    const inner = state.mode === "landscape" ? radius * (1 - state.landscapeBrush.falloff) : 0;
    const lines = [circle(radius), inner > radius * 0.05 ? circle(inner) : Array.from({ length: RING_SEGMENTS + 1 }, () => point.add(normal.scale(RING_LIFT)))];
    const colors = [lines[0]!.map(() => RING_COLOR), lines[1]!.map(() => RING_INNER_COLOR)];
    const created = !ring;
    ring = MeshBuilder.CreateLineSystem("sceneBrushPreview", { lines, colors, useVertexAlpha: true, instance: ring ?? undefined, updatable: true }, handle.scene);
    ring.isPickable = false;
    ring.renderingGroupId = RENDERING_GROUP.foreground;
    if (created) freezeEditorActiveMeshes(handle.scene);
    handle.scheduler.invalidate("manual");
  };
  const cellKey = (p: Vector3, spacing: number) => `${Math.floor(p.x / spacing)}:${Math.floor(p.y / spacing)}:${Math.floor(p.z / spacing)}`;
  const occupy = (current: Stroke, point: Vector3) => {
    const key = cellKey(point, current.state.foliageBrush.spacing);
    const cell = current.occupied.get(key) ?? []; cell.push(point); current.occupied.set(key, cell);
  };
  const hasNeighbour = (current: Stroke, point: Vector3) => {
    const spacing = current.state.foliageBrush.spacing;
    const x = Math.floor(point.x / spacing); const y = Math.floor(point.y / spacing); const z = Math.floor(point.z / spacing);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (current.occupied.get(`${x + dx}:${y + dy}:${z + dz}`)?.some((other) => Vector3.DistanceSquared(other, point) < spacing * spacing)) return true;
    }
    return false;
  };
  const dab = (current: Stroke, point: Vector3) => {
    const state = current.state;
    if (state.mode === "landscape") {
      current.next = { ...current.next, actors: current.next.actors.map((actor) => ({ ...actor, components: actor.components.map((component) => {
        if (`${actor.id}/${component.id}` !== state.landscapeSelection || component.classId !== "LandscapeComponent" || actor.locked) return component;
        const root = handle.editor?.sync.meshForComponent(actor.id, component.id);
        if (!root) return component;
        const world = root.computeWorldMatrix(true);
        const local = Vector3.TransformCoordinates(point, Matrix.Invert(world));
        const scale = new Vector3(); world.decompose(scale);
        const data = sculptLandscape(parseLandscapeProperties(component.properties), local.x, local.z, {
          ...state.landscapeBrush, tool: state.landscapeTool as LandscapeBrush["tool"], radius: state.landscapeBrush.radius / Math.max(0.001, Math.abs(scale.x), Math.abs(scale.z)),
        });
        return { ...component, properties: { ...data } };
      }) })) };
    } else if (state.foliageTool === "erase") {
      current.next = { ...current.next, actors: current.next.actors.flatMap((actor) => {
        if (actor.locked || !actor.visible) return [actor];
        const components = actor.components.flatMap((component) => {
          if (component.classId !== "FoliageComponent") return [component];
          const root = handle.editor?.sync.meshForComponent(actor.id, component.id);
          if (!root) return [component];
          const world = root.computeWorldMatrix(true);
          const data = parseFoliageProperties(component.properties);
          const batches = data.batches.map((batch) => ({ ...batch, transforms: batch.transforms.filter((transform) =>
            Vector3.Distance(Vector3.TransformCoordinates(Vector3.FromArray(transform.position), world), point) > state.foliageBrush.radius) })).filter((batch) => batch.transforms.length);
          return batches.length ? [{ ...component, properties: { ...data, batches } }] : [];
        });
        return components.length || current.next.actors.some((child) => child.parentId === actor.id)
          ? [{ ...actor, components }] : actor.components.length ? [] : [actor];
      }) };
    } else if (state.group) {
      const brush = state.foliageBrush;
      const count = Math.min(256, Math.max(1, Math.round(Math.PI * brush.radius ** 2 * brush.density)));
      for (let i = 0; i < count; i++) {
        const angle = random() * Math.PI * 2; const radius = Math.sqrt(random()) * brush.radius;
        const height = Math.max(100, brush.radius * 2);
        const hit = handle.scene.pickWithRay(new Ray(new Vector3(point.x + Math.cos(angle) * radius, point.y + height, point.z + Math.sin(angle) * radius), Vector3.Down(), height * 2), predicate(state));
        const normal = hit?.getNormal(true, true)?.normalize(); const position = hit?.pickedPoint;
        if (!position || !normal || normal.y < Math.cos(brush.maxSlope * Math.PI / 180) || hasNeighbour(current, position)) continue;
        const model = chooseFoliageModel(state.group, random()); if (!model) continue;
        const scale = model.minScale + random() * (model.maxScale - model.minScale);
        const yaw = Quaternion.RotationAxis(Vector3.Up(), brush.randomYaw ? random() * Math.PI * 2 : 0);
        const rotation = brush.alignToNormal ? alignment(normal).multiply(yaw) : yaw;
        current.foliage = appendFoliageInstance(current.foliage, model, { position: [position.x, position.y, position.z], rotation: [rotation.x, rotation.y, rotation.z, rotation.w], scale: [scale, scale, scale] });
        occupy(current, position);
      }
      if (current.foliage.batches.length) current.next = { ...current.before, actors: [...current.before.actors, createActor(current.actorId, `${state.group.name} Stroke`, {
        components: [{ id: current.componentId, classId: "FoliageComponent", transform: identitySerializedTransform(), properties: { ...current.foliage } }],
      })] };
    }
    // Foliage is published once on release; the footprint previews placement without repeatedly decoding models.
    if (state.mode === "landscape") handle.editor?.sync.apply(current.next);
  };
  const finish = (cancel: boolean) => {
    const current = stroke; stroke = null;
    if (!current) return;
    if (canvas.hasPointerCapture(current.pointerId)) canvas.releasePointerCapture(current.pointerId);
    const latest = options.getState();
    if (cancel || latest.scene !== current.before || !enabled(latest)) {
      if (latest.scene) handle.editor?.sync.apply(latest.scene);
      return;
    }
    if (current.next === current.before) return;
    pending = true;
    void options.commit(current.next, current.before).then((ok) => {
      if (!ok && options.getState().scene) handle.editor?.sync.apply(options.getState().scene!);
    }).catch((error: unknown) => {
      if (options.getState().scene) handle.editor?.sync.apply(options.getState().scene!);
      options.onError?.(error);
    }).finally(() => { pending = false; });
  };
  const consume = (event: PointerEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const down = (event: PointerEvent) => {
    const state = options.getState();
    if (!enabled(state) || (event.pointerType === "mouse" && event.button !== 0)) return;
    consume(event); pointers.add(event.pointerId);
    if (pointers.size > 1) { finish(true); return; }
    if (pending || !state.scene || (state.mode === "foliage" && state.foliageTool === "paint" && !state.group?.models.length)) return;
    const hit = pick(event, state); if (!hit?.pickedPoint) return;
    stroke = { pointerId: event.pointerId, before: state.scene, next: state.scene, state, last: hit.pickedPoint.clone(), foliage: { groupId: state.group?.id ?? "", batches: [] }, actorId: crypto.randomUUID(), componentId: crypto.randomUUID(), occupied: new Map() };
    if (state.mode === "foliage") for (const actor of state.scene.actors) for (const component of actor.components) {
      if (component.classId !== "FoliageComponent") continue;
      const world = handle.editor?.sync.meshForComponent(actor.id, component.id)?.computeWorldMatrix(true); if (!world) continue;
      for (const batch of parseFoliageProperties(component.properties).batches) for (const transform of batch.transforms) occupy(stroke, Vector3.TransformCoordinates(Vector3.FromArray(transform.position), world));
    }
    canvas.setPointerCapture(event.pointerId);
    dab(stroke, hit.pickedPoint);
  };
  const move = (event: PointerEvent) => {
    const state = options.getState();
    if (!enabled(state)) { hideRing(); finish(true); return; }
    const hit = pick(event, state);
    if (hit?.pickedPoint) showRing(hit.pickedPoint, hit.getNormal(true, true)?.normalize() ?? Vector3.Up(), state);
    else hideRing();
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    consume(event);
    if (state.scene !== stroke.before) { finish(true); return; }
    if (!hit?.pickedPoint) { stroke.last = null; return; }
    const step = Math.max(0.05, radiusOf(state) * 0.2);
    const start = stroke.last ?? hit.pickedPoint;
    const distance = Vector3.Distance(start, hit.pickedPoint);
    const count = Math.min(128, Math.floor(distance / step));
    if (!stroke.last) dab(stroke, hit.pickedPoint);
    for (let i = 1; i <= count; i++) dab(stroke, Vector3.Lerp(start, hit.pickedPoint, Math.min(1, i * step / distance)));
    if (count || !stroke.last) stroke.last = hit.pickedPoint.clone();
  };
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    consume(event);
    if (stroke?.pointerId === event.pointerId) finish(event.type !== "pointerup");
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z")) finish(true); };
  const leave = () => { if (!stroke) hideRing(); };
  canvas.addEventListener("pointerdown", down, true); canvas.addEventListener("pointermove", move, true);
  canvas.addEventListener("pointerup", up, true); canvas.addEventListener("pointercancel", up, true);
  canvas.addEventListener("lostpointercapture", up, true); canvas.addEventListener("pointerleave", leave);
  window.addEventListener("keydown", key, true);
  return () => {
    finish(true); hideRing();
    canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move, true);
    canvas.removeEventListener("pointerup", up, true); canvas.removeEventListener("pointercancel", up, true);
    canvas.removeEventListener("lostpointercapture", up, true); canvas.removeEventListener("pointerleave", leave);
    window.removeEventListener("keydown", key, true);
  };
}
