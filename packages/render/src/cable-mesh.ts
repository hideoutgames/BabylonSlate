import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";
import { parseCableProperties, type CableProperties } from "@babylonslate/core";
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

function updateSurface(surface: CableSurface): void {
  const { mesh, points, positions, normals, circle, properties } = surface;
  const world = mesh.computeWorldMatrix();
  if (!surface.dirty && (!surface.worldSpace || surface.world.equals(world))) return;
  if (surface.worldSpace) {
    if (Math.abs(world.determinant()) < 1e-12) return;
    world.invertToRef(surface.inverse);
    surface.world.copyFrom(world);
  }
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
    let length = Math.hypot(dx, dy, dz);
    if (length < 1e-8 && i < count - 1) {
      dx = points[next]! - points[i * 3]!;
      dy = points[next + 1]! - points[i * 3 + 1]!;
      dz = points[next + 2]! - points[i * 3 + 2]!;
      length = Math.hypot(dx, dy, dz);
    }
    if (length >= 1e-8) { tx = dx / length; ty = dy / length; tz = dz / length; }
    // Parallel transport avoids the twists caused by choosing a fresh up axis
    // for every ring, including vertical and coincident particles.
    const along = nx * tx + ny * ty + nz * tz;
    nx -= along * tx; ny -= along * ty; nz -= along * tz;
    length = Math.hypot(nx, ny, nz);
    if (length < 1e-8) {
      if (Math.abs(ty) < 0.9) { nx = -ty * tx; ny = 1 - ty * ty; nz = -ty * tz; }
      else { nx = 1 - tx * tx; ny = -tx * ty; nz = -tx * tz; }
      length = Math.hypot(nx, ny, nz);
    }
    nx /= length; ny /= length; nz /= length;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
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
}

/** Static authored preview; no simulation or editor render-loop subscription. */
export function updateCablePreview(mesh: Mesh, end: readonly number[], start?: readonly number[]): void {
  const surface = surfaces.get(mesh);
  if (!surface || surface.history?.latest !== undefined && surface.history.latest >= 0) return;
  const sx = start?.[0] ?? 0, sy = start?.[1] ?? 0, sz = start?.[2] ?? 0;
  if (surface.previewEnd.x === end[0] && surface.previewEnd.y === end[1] && surface.previewEnd.z === end[2] && surface.previewStart.x === sx && surface.previewStart.y === sy && surface.previewStart.z === sz && (!start || surface.world.equals(mesh.computeWorldMatrix()))) return;
  surface.previewEnd.set(end[0]!, end[1]!, end[2]!);
  surface.previewStart.set(sx, sy, sz);
  const { points, properties } = surface;
  const dx = end[0]! - sx, dy = end[1]! - sy, dz = end[2]! - sz;
  const distance = Math.hypot(dx, dy, dz);
  // Parabolic rest preview gives a readable slack silhouette without paying
  // for a settled simulation on each editor document update.
  const sag = properties.attachEnd ? Math.sqrt(Math.max(0, properties.cableLength ** 2 - distance ** 2)) / 2 : 0;
  for (let i = 0; i <= properties.numSegments; i++) {
    const t = i / properties.numSegments;
    points[i * 3] = sx + dx * t;
    points[i * 3 + 1] = sy + dy * t - sag * 4 * t * (1 - t);
    points[i * 3 + 2] = sz + dz * t;
  }
  surface.worldSpace = !!start;
  surface.dirty = true;
  updateSurface(surface);
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
      indices.set([a, a + 1, a + columns, a + 1, a + columns + 1, a + columns], offset);
    }
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals, true);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
  mesh.setIndices(indices, null, false);
  const surface: CableSurface = { mesh, properties, points: new Float32Array(rings * 3), positions, normals, circle, world: Matrix.Identity(), inverse: Matrix.Identity(), point: new Vector3(), normal: new Vector3(), minimum: new Vector3(), maximum: new Vector3(), previewEnd: new Vector3(NaN, NaN, NaN), previewStart: new Vector3(NaN, NaN, NaN), actorForSlot, worldSpace: false, dirty: true };
  surfaces.set(mesh, surface);
  updateCablePreview(mesh, properties.endPosition);
  if (simulationId !== undefined && Number.isSafeInteger(simulationId) && simulationId > 0) {
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
