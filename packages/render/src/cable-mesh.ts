import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";
import { CableSimulation, cablePropertiesEqual, parseCableProperties, writeCableRestShape, type CableProperties } from "@babylonslate/core";
import { updateDynamicMaterialBounds } from "./material-bounds";

const HISTORY_SIZE = 16;
type CableSnapshot = { frameId: number; previousFrameId: number; alpha: number };
type CableHistory = {
  frames: Float64Array;
  points: Float32Array;
  anchors: Float64Array;
  cursor: number;
  latest: number;
  previous: Float32Array;
  next: Float32Array;
  previousAnchors: Float64Array;
  nextAnchors: Float64Array;
  previousFrame: number;
  nextFrame: number;
  previousPacket: number;
  nextPacket: number;
  alpha: number;
  pending: boolean;
};

type CableSurface = {
  mesh: Mesh;
  properties: CableProperties;
  points: Float32Array;
  positions: Float32Array;
  normals: Float32Array;
  circle: Float32Array;
  world: Matrix;
  inverse: Matrix;
  point: Vector3;
  normal: Vector3;
  previewEnd: Vector3;
  previewStart: Vector3;
  previewAcceleration: Vector3;
  /** World-space vertices under a mirrored world matrix reverse the ring to keep outward faces. */
  mirrored: boolean;
  minimum: Vector3;
  maximum: Vector3;
  history?: CableHistory;
  actorForSlot?: (slotId: number) => Mesh | undefined;
  worldSpace: boolean;
  dirty: boolean;
};

const surfaces = new WeakMap<Mesh, CableSurface>();
const sceneSurfaces = new WeakMap<Scene, Set<CableSurface>>();
// A prepared visual can coexist with its predecessor until an asynchronous model
// finishes. Both receive the same frame; disposal only removes that mesh.
const runtimeSurfaces = new WeakMap<Scene, Map<number, Set<CableSurface>>>();
const snapshots = new WeakMap<Scene, CableSnapshot>();
// Editor (non-Play) cable meshes by name. Replacement visuals can briefly share
// a name with their predecessor, so each name keeps every live candidate.
const editorMeshes = new WeakMap<Scene, Map<string, Set<Mesh>>>();
const DEFAULT_GRAVITY: readonly number[] = [0, -9.81, 0];
const previewStart = new Float64Array(3);
const previewAcceleration = new Float64Array(3);

/** Only this owner writes these dynamic buffers, and always emits geometry revisions. */
export function hasRevisionTrackedCableGeometry(mesh: Mesh): boolean {
  const surface = surfaces.get(mesh);
  return !!surface && mesh.getVerticesData(VertexBuffer.PositionKind) === surface.positions && mesh.getVerticesData(VertexBuffer.NormalKind) === surface.normals;
}

/** Pair with the actor snapshot, so future packets cannot pull anchors ahead. */
export function sampleCableFrame(scene: Scene, frameId: number, previousFrameId: number, alpha: number): void {
  let snapshot = snapshots.get(scene);
  if (!snapshot) { snapshot = { frameId, previousFrameId, alpha }; snapshots.set(scene, snapshot); }
  else { snapshot.frameId = frameId; snapshot.previousFrameId = previousFrameId; snapshot.alpha = alpha; }
}

/** Coalesce worker packets into one upload at actual render admission. */
export function flushSceneCables(scene: Scene): void {
  const entries = sceneSurfaces.get(scene);
  if (!entries) return;
  const snapshot = snapshots.get(scene);
  for (const surface of entries) if (surface.mesh.isEnabled()) {
    selectCablePoints(surface, snapshot);
    pinCableEndpoints(surface);
    updateSurface(surface);
  }
}

function packetAtOrBefore(history: CableHistory, frameId: number): number {
  let selected = -1, selectedFrame = -1;
  for (let i = 0; i < HISTORY_SIZE; i++) {
    const frame = history.frames[i]!;
    if (frame <= frameId && frame > selectedFrame) { selected = i; selectedFrame = frame; }
  }
  return selected;
}

function selectCablePoints(surface: CableSurface, snapshot: CableSnapshot | undefined): void {
  const history = surface.history;
  if (!history || history.latest < 0) return;
  const frameId = snapshot?.frameId ?? history.latest;
  const previousFrameId = snapshot?.previousFrameId ?? frameId;
  const alpha = Math.max(0, Math.min(1, snapshot?.alpha ?? 1));
  const oldPrevious = history.previousPacket, oldNext = history.nextPacket;
  const selectedChanged = history.previousFrame !== previousFrameId || history.nextFrame !== frameId;
  if (history.pending || selectedChanged) {
    const width = surface.points.length;
    // Keep both selected snapshot shapes pinned even if later packets wrap the
    // bounded history while this renderer is still displaying an older pair.
    const retainPrevious = history.previousFrame === previousFrameId || history.nextFrame === previousFrameId;
    if (history.previousFrame !== previousFrameId && history.nextFrame === previousFrameId) {
      history.previous.set(history.next);
      history.previousAnchors.set(history.nextAnchors);
      history.previousPacket = history.nextPacket;
    }
    let a = packetAtOrBefore(history, previousFrameId), b = packetAtOrBefore(history, frameId);
    // A heavily delayed render may outlive the bounded history. Keep a pinned
    // pair when available; otherwise display the nearest retained shape and
    // correct its attached endpoints against the sampled actor transforms.
    if (b < 0 && history.nextFrame !== frameId) b = (history.cursor + HISTORY_SIZE - 1) % HISTORY_SIZE;
    if (a < 0 && !retainPrevious) a = b;
    if (a >= 0 && (!retainPrevious || history.frames[a]! > history.previousPacket)) {
      for (let i = 0; i < width; i++) history.previous[i] = history.points[a * width + i]!;
      for (let i = 0; i < 8; i++) history.previousAnchors[i] = history.anchors[a * 8 + i]!;
      history.previousPacket = history.frames[a]!;
    }
    if (b >= 0 && (history.nextFrame !== frameId || history.frames[b]! > history.nextPacket)) {
      for (let i = 0; i < width; i++) history.next[i] = history.points[b * width + i]!;
      for (let i = 0; i < 8; i++) history.nextAnchors[i] = history.anchors[b * 8 + i]!;
      history.nextPacket = history.frames[b]!;
    }
    if (history.nextPacket < 0) return; // Still waiting for this snapshot's first cable packet.
    if (history.previousPacket < 0) {
      history.previous.set(history.next);
      history.previousAnchors.set(history.nextAnchors);
      history.previousPacket = history.nextPacket;
    }
    history.previousFrame = previousFrameId;
    history.nextFrame = frameId;
    history.pending = false;
  }
  const effectiveAlpha = history.previousPacket === history.nextPacket ? 1 : alpha;
  if (oldPrevious === history.previousPacket && oldNext === history.nextPacket && history.alpha === effectiveAlpha) return;
  for (let i = 0; i < surface.points.length; i++) surface.points[i] = history.previous[i]! + (history.next[i]! - history.previous[i]!) * effectiveAlpha;
  history.alpha = effectiveAlpha;
  surface.worldSpace = true;
  surface.dirty = true;
}

function pinCableEndpoints(surface: CableSurface): void {
  const history = surface.history;
  if (!history || history.nextPacket < 0 || !surface.actorForSlot) return;
  for (let endpoint = 0; endpoint < 2; endpoint++) {
    if (endpoint === 0 ? !surface.properties.attachStart : !surface.properties.attachEnd) continue;
    const slotId = history.nextAnchors[endpoint]!;
    if (slotId < 0) continue;
    const root = surface.actorForSlot(slotId);
    if (!root || root.isDisposed()) continue;
    const offset = 2 + endpoint * 3;
    const alpha = history.previousAnchors[endpoint] === slotId ? history.alpha : 1;
    const previous = history.previousAnchors, next = history.nextAnchors;
    surface.point.set(previous[offset]! + (next[offset]! - previous[offset]!) * alpha, previous[offset + 1]! + (next[offset + 1]! - previous[offset + 1]!) * alpha, previous[offset + 2]! + (next[offset + 2]! - previous[offset + 2]!) * alpha);
    Vector3.TransformCoordinatesToRef(surface.point, root.computeWorldMatrix(), surface.point);
    const particle = endpoint === 0 ? 0 : surface.points.length - 3;
    if (surface.points[particle] !== Math.fround(surface.point.x) || surface.points[particle + 1] !== Math.fround(surface.point.y) || surface.points[particle + 2] !== Math.fround(surface.point.z)) {
      surface.point.toArray(surface.points, particle);
      surface.dirty = true;
    }
  }
}

/** Rebuild the tube when its points changed or its world frame moved; returns whether it uploaded. */
function updateSurface(surface: CableSurface): boolean {
  const { mesh, points, positions, normals, circle, properties } = surface;
  const world = mesh.computeWorldMatrix();
  const worldChanged = surface.worldSpace && !surface.world.equals(world);
  if (!surface.dirty && !worldChanged) return false;
  if (worldChanged) {
    const determinant = world.determinant();
    if (Math.abs(determinant) < 1e-12) return false;
    world.invertToRef(surface.inverse);
    surface.world.copyFrom(world);
    // Babylon flips culling for a negative determinant. Vertices already in
    // world space must reverse their ring so the flipped faces still face out.
    surface.mirrored = determinant < 0;
  }
  const mirror = surface.worldSpace && surface.mirrored ? -1 : 1;
  const radius = properties.cableWidth / 2;
  const count = points.length / 3;
  const sides = properties.numSides;
  let tx = 1, ty = 0, tz = 0;
  let nx = 0, ny = 1, nz = 0;
  surface.minimum.setAll(Infinity);
  surface.maximum.setAll(-Infinity);
  for (let i = 0; i < count; i++) {
    const previous = Math.max(0, i - 1) * 3;
    const next = Math.min(count - 1, i + 1) * 3;
    let dx = points[next]! - points[previous]!;
    let dy = points[next + 1]! - points[previous + 1]!;
    let dz = points[next + 2]! - points[previous + 2]!;
    let length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-8 && i < count - 1) {
      dx = points[next]! - points[i * 3]!;
      dy = points[next + 1]! - points[i * 3 + 1]!;
      dz = points[next + 2]! - points[i * 3 + 2]!;
      length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    if (length >= 1e-8) { tx = dx / length; ty = dy / length; tz = dz / length; }
    // Parallel transport avoids the twists caused by choosing a fresh up axis
    // for every ring, including vertical and coincident particles.
    const along = nx * tx + ny * ty + nz * tz;
    nx -= along * tx; ny -= along * ty; nz -= along * tz;
    length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length < 1e-8) {
      if (Math.abs(ty) < 0.9) { nx = -ty * tx; ny = 1 - ty * ty; nz = -ty * tz; }
      else { nx = 1 - tx * tx; ny = -tx * ty; nz = -tx * tz; }
      length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    }
    nx /= length; ny /= length; nz /= length;
    const bx = (ty * nz - tz * ny) * mirror, by = (tz * nx - tx * nz) * mirror, bz = (tx * ny - ty * nx) * mirror;
    for (let side = 0; side <= sides; side++) {
      const cosine = circle[side * 2]!, sine = circle[side * 2 + 1]!;
      const rx = nx * cosine + bx * sine, ry = ny * cosine + by * sine, rz = nz * cosine + bz * sine;
      const vertex = (i * (sides + 1) + side) * 3;
      surface.point.set(points[i * 3]! + radius * rx, points[i * 3 + 1]! + radius * ry, points[i * 3 + 2]! + radius * rz);
      surface.normal.set(rx, ry, rz);
      if (surface.worldSpace) {
        Vector3.TransformCoordinatesToRef(surface.point, surface.inverse, surface.point);
        // Inverse of the normal transform: transpose(world), preserving a
        // circular world-space cable under non-uniformly scaled attachments.
        const m = world.m;
        surface.normal.set(rx * m[0]! + ry * m[1]! + rz * m[2]!, rx * m[4]! + ry * m[5]! + rz * m[6]!, rx * m[8]! + ry * m[9]! + rz * m[10]!).normalize();
      }
      surface.point.toArray(positions, vertex);
      surface.normal.toArray(normals, vertex);
      surface.point.set(positions[vertex]!, positions[vertex + 1]!, positions[vertex + 2]!);
      surface.minimum.minimizeInPlace(surface.point);
      surface.maximum.maximizeInPlace(surface.point);
    }
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false);
  mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
  const extent = mesh.geometry!.extend;
  extent.minimum.copyFrom(surface.minimum);
  extent.maximum.copyFrom(surface.maximum);
  // The single global submesh shares these bounds, including its picking path.
  updateDynamicMaterialBounds(mesh, surface.minimum, surface.maximum);
  surface.dirty = false;
  return true;
}

/**
 * Static settled preview (the shared rest shape) for loads and thumbnails, and
 * for Play before the first packet. World-space when `start` is given;
 * otherwise local to the mesh. Editor viewports simulate via `bindEditorCable`.
 */
export function updateCablePreview(mesh: Mesh, end: readonly number[], start?: readonly number[], gravity: readonly number[] = DEFAULT_GRAVITY): void {
  const surface = surfaces.get(mesh);
  if (!surface || surface.history?.latest !== undefined && surface.history.latest >= 0) return;
  // Document edits can change an ancestor after its matrix was cached in this
  // render ID. Refresh the hierarchy before projecting world-space endpoints;
  // the later static freeze must not apply that ancestor transform a second time.
  if (start) mesh.computeWorldMatrix(true);
  const { points, properties } = surface;
  previewStart[0] = start?.[0] ?? 0; previewStart[1] = start?.[1] ?? 0; previewStart[2] = start?.[2] ?? 0;
  for (let axis = 0; axis < 3; axis++) {
    const value = gravity[axis];
    previewAcceleration[axis] = (Number.isFinite(value) ? value! : 0) * properties.gravityScale + properties.cableForce[axis]!;
  }
  if (surface.previewEnd.x === end[0] && surface.previewEnd.y === end[1] && surface.previewEnd.z === end[2] &&
    surface.previewStart.x === previewStart[0] && surface.previewStart.y === previewStart[1] && surface.previewStart.z === previewStart[2] &&
    surface.previewAcceleration.x === previewAcceleration[0] && surface.previewAcceleration.y === previewAcceleration[1] &&
    surface.previewAcceleration.z === previewAcceleration[2] &&
    surface.worldSpace === !!start && (!start || surface.world.equals(mesh.computeWorldMatrix()))) return;
  surface.previewEnd.set(end[0]!, end[1]!, end[2]!);
  surface.previewStart.set(previewStart[0]!, previewStart[1]!, previewStart[2]!);
  surface.previewAcceleration.set(previewAcceleration[0]!, previewAcceleration[1]!, previewAcceleration[2]!);
  writeCableRestShape(points, previewStart, end, properties.cableLength, previewAcceleration, properties.attachStart, properties.attachEnd, properties.numSegments);
  surface.worldSpace = !!start;
  surface.dirty = true;
  updateSurface(surface);
}

/**
 * Apply property edits that keep this mesh's topology (segments, sides and
 * tiling rebuild the visual instead). The next preview or editor binding uses
 * the new values without disposing the mesh or its simulation.
 */
export function configureCableMesh(mesh: Mesh, input: Partial<CableProperties>): void {
  const surface = surfaces.get(mesh);
  if (!surface) return;
  const properties = parseCableProperties(input);
  if (cablePropertiesEqual(surface.properties, properties)) return;
  const current = surface.properties;
  if (properties.numSegments !== current.numSegments || properties.numSides !== current.numSides || properties.tileMaterial !== current.tileMaterial) return;
  surface.properties = properties;
  surface.previewEnd.set(NaN, NaN, NaN);
  surface.dirty = true;
}

/** Allocate topology once. Only position/normal buffers change during Play. */
export function createCableMesh(scene: Scene, name: string, input: Partial<CableProperties>, simulationId?: number, actorForSlot?: (slotId: number) => Mesh | undefined): Mesh {
  const properties = parseCableProperties(input);
  const mesh = new Mesh(name, scene);
  mesh.setEnabled(properties.enabled);
  const rings = properties.numSegments + 1, columns = properties.numSides + 1;
  const positions = new Float32Array(rings * columns * 3), normals = new Float32Array(positions.length);
  const uvs = new Float32Array(rings * columns * 2), circle = new Float32Array(columns * 2);
  const indices = new Uint16Array(properties.numSegments * properties.numSides * 6);
  for (let side = 0; side < columns; side++) {
    circle[side * 2] = Math.cos(side / properties.numSides * Math.PI * 2);
    circle[side * 2 + 1] = Math.sin(side / properties.numSides * Math.PI * 2);
  }
  for (let ring = 0; ring < rings; ring++) for (let side = 0; side < columns; side++) {
    const a = ring * columns + side;
    uvs[a * 2] = side / properties.numSides;
    uvs[a * 2 + 1] = ring / properties.numSegments * properties.tileMaterial;
    if (ring < rings - 1 && side < columns - 1) {
      const offset = (ring * properties.numSides + side) * 6;
      // Counter-clockwise seen from outside: front faces point away from the axis.
      indices[offset] = a; indices[offset + 1] = a + columns; indices[offset + 2] = a + 1;
      indices[offset + 3] = a + 1; indices[offset + 4] = a + columns; indices[offset + 5] = a + columns + 1;
    }
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals, true);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
  mesh.setIndices(indices, null, false);
  const surface: CableSurface = { mesh, properties, points: new Float32Array(rings * 3), positions, normals, circle, world: Matrix.Identity(), inverse: Matrix.Identity(), point: new Vector3(), normal: new Vector3(), minimum: new Vector3(), maximum: new Vector3(), previewEnd: new Vector3(NaN, NaN, NaN), previewStart: new Vector3(NaN, NaN, NaN), previewAcceleration: new Vector3(NaN, NaN, NaN), mirrored: false, actorForSlot, worldSpace: false, dirty: true };
  surfaces.set(mesh, surface);
  updateCablePreview(mesh, properties.endPosition);
  if (simulationId === undefined || !Number.isSafeInteger(simulationId) || simulationId <= 0) registerEditorCableMesh(scene, mesh);
  else {
    surface.history = { frames: new Float64Array(HISTORY_SIZE).fill(-1), points: new Float32Array(surface.points.length * HISTORY_SIZE), anchors: new Float64Array(HISTORY_SIZE * 8), cursor: 0, latest: -1, previous: new Float32Array(surface.points.length), next: new Float32Array(surface.points.length), previousAnchors: new Float64Array(8), nextAnchors: new Float64Array(8), previousFrame: -1, nextFrame: -1, previousPacket: -1, nextPacket: -1, alpha: -1, pending: false };
    let entries = sceneSurfaces.get(scene);
    if (!entries) {
      entries = new Set();
      sceneSurfaces.set(scene, entries);
      const observer = scene.onBeforeRenderObservable.add(() => flushSceneCables(scene), -1, true);
      scene.onDisposeObservable.addOnce(() => {
        scene.onBeforeRenderObservable.remove(observer);
        sceneSurfaces.delete(scene);
        runtimeSurfaces.delete(scene);
        snapshots.delete(scene);
      });
    }
    entries.add(surface);
    let ids = runtimeSurfaces.get(scene);
    if (!ids) { ids = new Map(); runtimeSurfaces.set(scene, ids); }
    let matching = ids.get(simulationId);
    if (!matching) { matching = new Set(); ids.set(simulationId, matching); }
    for (const previous of matching) if (previous.worldSpace && previous.points.length === surface.points.length) {
      surface.points.set(previous.points);
      surface.worldSpace = true;
      surface.dirty = true;
      updateSurface(surface);
      break;
    }
    matching.add(surface);
    mesh.onDisposeObservable.addOnce(() => {
      entries.delete(surface);
      matching.delete(surface);
      if (matching.size === 0) ids.delete(simulationId);
    });
  }
  return mesh;
}

/** Packed records: id/count, actor slots, actor-local anchors, then world xyz. */
export function applyCableFrame(scene: Scene, data: Float32Array, frameId: number): void {
  const entries = runtimeSurfaces.get(scene);
  if (!entries || !Number.isSafeInteger(frameId) || frameId < 0) return;
  for (let offset = 0; offset + 10 <= data.length;) {
    const id = data[offset++]!, count = data[offset++]!;
    if (!Number.isInteger(count) || count < 2 || count > 65 || offset + 8 + count * 3 > data.length) return;
    const anchors = offset;
    offset += 8;
    const end = offset + count * 3;
    let finite = true;
    for (let i = anchors; i < end; i++) if (!Number.isFinite(data[i])) { finite = false; break; }
    const matching = entries.get(id);
    if (finite && matching) for (const surface of matching) {
      if (surface.points.length !== count * 3) continue;
      const history = surface.history!;
      if (frameId <= history.latest) continue;
      const record = history.cursor;
      history.frames[record] = frameId;
      for (let i = 0; i < 8; i++) history.anchors[record * 8 + i] = data[anchors + i]!;
      for (let i = 0; i < surface.points.length; i++) history.points[record * surface.points.length + i] = data[offset + i]!;
      history.cursor = (record + 1) % HISTORY_SIZE;
      history.latest = frameId;
      history.pending = true;
    }
    offset = end;
  }
}

// Editor viewport simulation. Cables in scene and Class viewports gently
// simulate on the main thread so they react while actors or targets are
// dragged, then sleep. There is no physics world in the editor, so editor
// cables never collide. An idle cable costs two world-matrix flag compares.
type EditorCable = {
  name: string;
  surface: CableSurface;
  properties: CableProperties;
  simulation: CableSimulation;
  /** Node framing `endLocal`: the target actor root, or the cable mesh for a self target. */
  endNode: TransformNode;
  endSelf: boolean;
  endActorId: string | null;
  rootForActor: ((actorId: string) => TransformNode | null | undefined) | null;
  endLocal: Vector3;
  start: [number, number, number];
  end: [number, number, number];
  gravity: [number, number, number];
  startFlag: number;
  endFlag: number;
  /** The surface does not show the simulation state yet (new or replaced mesh). */
  pending: boolean;
};

type EditorCables = { cables: Map<string, EditorCable>; lastTime: number | null };
const editorCables = new WeakMap<Scene, EditorCables>();
const ORIGIN: readonly number[] = [0, 0, 0];

export type EditorCableBinding = {
  /** Node whose world matrix frames `endLocal`: the target actor root, or the cable mesh itself. */
  endNode: TransformNode;
  endLocal: readonly number[];
  gravity: readonly number[];
  /** Re-resolves the target root when its visual is replaced between document applies. */
  endActorId?: string;
  rootForActor?: (actorId: string) => TransformNode | null | undefined;
};

function registerEditorCableMesh(scene: Scene, mesh: Mesh): void {
  let names = editorMeshes.get(scene);
  if (!names) {
    names = new Map();
    editorMeshes.set(scene, names);
  }
  const name = mesh.name;
  let meshes = names.get(name);
  if (!meshes) {
    meshes = new Set();
    names.set(name, meshes);
  }
  meshes.add(mesh);
  const owner = names;
  mesh.onDisposeObservable.addOnce(() => {
    const current = owner.get(name);
    current?.delete(mesh);
    if (current?.size === 0) owner.delete(name);
  });
}

/** Whether this scene holds editor (non-Play) cable meshes. */
export function hasEditorCableMeshes(scene: Scene): boolean {
  return (editorMeshes.get(scene)?.size ?? 0) > 0;
}

/** Resolve an editor cable mesh by name in O(1), preferring the one under `root`. */
export function findEditorCableMesh(scene: Scene, name: string, root?: TransformNode | null): Mesh | null {
  const meshes = editorMeshes.get(scene)?.get(name);
  if (!meshes) return null;
  let fallback: Mesh | null = null;
  for (const mesh of meshes) {
    if (mesh.isDisposed()) continue;
    if (!root || mesh.isDescendantOf(root)) return mesh;
    fallback ??= mesh;
  }
  return fallback;
}

/**
 * Attach an editor cable mesh to its per-scene simulation, keyed by mesh name
 * (actor and component). A rebuilt mesh with the same segment count keeps the
 * existing simulation state; property edits reconfigure it in place.
 */
export function bindEditorCable(mesh: Mesh, binding: EditorCableBinding): void {
  const surface = surfaces.get(mesh);
  if (!surface || surface.history) return;
  const scene = mesh.getScene();
  let registry = editorCables.get(scene);
  if (!registry) {
    registry = { cables: new Map(), lastTime: null };
    editorCables.set(scene, registry);
  }
  const properties = surface.properties;
  const endSelf = binding.endNode === mesh;
  // A document apply may have moved ancestors after this render ID cached them.
  const startMatrix = mesh.computeWorldMatrix(true);
  const endMatrix = endSelf ? startMatrix : binding.endNode.computeWorldMatrix(true);
  let cable = registry.cables.get(mesh.name);
  if (!cable || cable.simulation.positions.length !== surface.points.length) {
    cable = {
      name: mesh.name, surface, properties, simulation: new CableSimulation(properties, ORIGIN, ORIGIN),
      endNode: binding.endNode, endSelf, endActorId: null, rootForActor: null, endLocal: new Vector3(),
      start: [0, 0, 0], end: [0, 0, 0], gravity: [0, 0, 0], startFlag: -1, endFlag: -1, pending: true,
    };
    registry.cables.set(mesh.name, cable);
  } else {
    if (cable.surface !== surface) {
      cable.surface = surface;
      cable.pending = true;
    }
    if (!cablePropertiesEqual(cable.properties, properties)) {
      cable.properties = properties;
      cable.simulation.configure(properties);
    }
  }
  cable.endNode = binding.endNode;
  cable.endSelf = endSelf;
  cable.endActorId = binding.endActorId ?? null;
  cable.rootForActor = binding.rootForActor ?? null;
  cable.endLocal.set(binding.endLocal[0] ?? 0, binding.endLocal[1] ?? 0, binding.endLocal[2] ?? 0);
  for (let axis = 0; axis < 3; axis++) {
    const value = binding.gravity[axis];
    cable.gravity[axis] = Number.isFinite(value) ? value! : 0;
  }
  readEditorAnchors(cable, startMatrix, endMatrix);
  if (!properties.attachStart && !properties.attachEnd) cable.simulation.reset(cable.start, cable.end);
  const changed = cable.simulation.update(0, cable.start, cable.end, cable.gravity);
  if (cable.pending || changed || !cable.simulation.sleeping) writeEditorCable(cable);
  else updateSurface(surface);
}

/** Drop simulations whose cables were not bound by the latest document apply. */
export function pruneEditorCables(scene: Scene, keep?: ReadonlySet<string>): void {
  const registry = editorCables.get(scene);
  if (!registry) return;
  for (const name of registry.cables.keys()) if (!keep?.has(name)) registry.cables.delete(name);
  if (registry.cables.size === 0) registry.lastTime = null;
}

/**
 * Advance editor cables to `nowMs` (editor render loop, before drawing).
 * Sleeping cables whose anchors' world matrices are unchanged cost two flag
 * compares and upload nothing. Returns whether any tube was updated.
 */
export function stepEditorCables(scene: Scene, nowMs: number): boolean {
  const registry = editorCables.get(scene);
  if (!registry || registry.cables.size === 0) return false;
  const last = registry.lastTime;
  registry.lastTime = nowMs;
  // The simulation drops any backlog beyond Max Substeps, e.g. after a hidden view.
  const dt = last === null ? 0 : Math.min(1, Math.max(0, (nowMs - last) / 1000));
  // Gizmo drags move nodes between frames; a new render ID makes the
  // world-matrix reads below observe them instead of last frame's cache.
  scene.incrementRenderId();
  let changed = false;
  for (const [name, cable] of registry.cables) {
    if (!adoptLiveMesh(scene, cable)) {
      registry.cables.delete(name);
      continue;
    }
    if (stepEditorCable(cable, dt)) changed = true;
  }
  return changed;
}

function stepEditorCable(cable: EditorCable, dt: number): boolean {
  const surface = cable.surface;
  const mesh = surface.mesh;
  const properties = cable.properties;
  if (!properties.enabled || !mesh.isEnabled()) return false;
  let endNode: TransformNode = mesh;
  if (!cable.endSelf) {
    endNode = cable.endNode;
    if (endNode.isDisposed()) {
      const replacement = cable.endActorId ? cable.rootForActor?.(cable.endActorId) : null;
      if (!replacement || replacement.isDisposed()) return false;
      cable.endNode = endNode = replacement;
      cable.endFlag = -1;
    }
  }
  const startMatrix = mesh.computeWorldMatrix();
  const endMatrix = endNode === mesh ? startMatrix : endNode.computeWorldMatrix();
  const sleeping = cable.simulation.sleeping;
  const moved = startMatrix.updateFlag !== cable.startFlag || endMatrix.updateFlag !== cable.endFlag;
  if (moved) readEditorAnchors(cable, startMatrix, endMatrix);
  else if (sleeping && !cable.pending) return false;
  // Released at both ends, a cable would fall forever: show its authored line.
  if (!properties.attachStart && !properties.attachEnd) {
    if (!moved && !cable.pending) return false;
    cable.simulation.reset(cable.start, cable.end);
    return writeEditorCable(cable);
  }
  const changed = cable.simulation.update(dt, cable.start, cable.end, cable.gravity);
  if (!changed && sleeping && !cable.pending) return updateSurface(surface);
  return writeEditorCable(cable);
}

function readEditorAnchors(cable: EditorCable, startMatrix: Matrix, endMatrix: Matrix): void {
  const s = startMatrix.m, e = endMatrix.m, local = cable.endLocal;
  cable.start[0] = s[12]!; cable.start[1] = s[13]!; cable.start[2] = s[14]!;
  cable.end[0] = local.x * e[0]! + local.y * e[4]! + local.z * e[8]! + e[12]!;
  cable.end[1] = local.x * e[1]! + local.y * e[5]! + local.z * e[9]! + e[13]!;
  cable.end[2] = local.x * e[2]! + local.y * e[6]! + local.z * e[10]! + e[14]!;
  cable.startFlag = startMatrix.updateFlag;
  cable.endFlag = endMatrix.updateFlag;
}

function writeEditorCable(cable: EditorCable): boolean {
  const surface = cable.surface;
  cable.simulation.writeInterpolated(surface.points);
  cable.pending = false;
  surface.worldSpace = true;
  surface.dirty = true;
  return updateSurface(surface);
}

/** Follow a visual replaced outside a document apply (e.g. an adopted model load). */
function adoptLiveMesh(scene: Scene, cable: EditorCable): boolean {
  if (!cable.surface.mesh.isDisposed()) return true;
  const meshes = editorMeshes.get(scene)?.get(cable.name);
  if (!meshes) return false;
  for (const mesh of meshes) {
    const surface = surfaces.get(mesh);
    if (!surface || mesh.isDisposed() || !mesh.isEnabled() || surface.points.length !== cable.simulation.positions.length) continue;
    cable.surface = surface;
    cable.startFlag = cable.endFlag = -1;
    cable.pending = true;
    if (!cablePropertiesEqual(cable.properties, surface.properties)) {
      cable.properties = surface.properties;
      cable.simulation.configure(surface.properties);
    }
    return true;
  }
  return false;
}
