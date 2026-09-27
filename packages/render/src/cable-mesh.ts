import { Matrix, Mesh, Vector3, VertexBuffer, type Scene } from "@babylonjs/core";
import { parseCableProperties, type CableProperties } from "@babylonslate/core";
import { applyMaterialBounds } from "./material-bounds";

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
  worldSpace: boolean;
  dirty: boolean;
};

const surfaces = new WeakMap<Mesh, CableSurface>();
const sceneSurfaces = new WeakMap<Scene, Set<CableSurface>>();
// A prepared visual can coexist with its predecessor until an asynchronous model
// finishes. Both receive the same frame; disposal only removes that mesh.
const runtimeSurfaces = new WeakMap<Scene, Map<number, Set<CableSurface>>>();

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
    }
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
  // Also update frozen world transforms and material displacement padding.
  mesh.getBoundingInfo().update(world);
  applyMaterialBounds(mesh, true);
  surface.dirty = false;
}

/** Static authored preview; no simulation or editor render-loop subscription. */
export function updateCablePreview(mesh: Mesh, end: readonly number[]): void {
  const surface = surfaces.get(mesh);
  if (!surface || surface.worldSpace) return;
  if (surface.previewEnd.x === end[0] && surface.previewEnd.y === end[1] && surface.previewEnd.z === end[2]) return;
  surface.previewEnd.set(end[0]!, end[1]!, end[2]!);
  const { points, properties } = surface;
  const distance = Math.hypot(end[0]!, end[1]!, end[2]!);
  // Parabolic rest preview gives a readable slack silhouette without paying
  // for a settled simulation on each editor document update.
  const sag = properties.attachEnd ? Math.sqrt(Math.max(0, properties.cableLength ** 2 - distance ** 2)) / 2 : 0;
  for (let i = 0; i <= properties.numSegments; i++) {
    const t = i / properties.numSegments;
    points[i * 3] = end[0]! * t;
    points[i * 3 + 1] = end[1]! * t - sag * 4 * t * (1 - t);
    points[i * 3 + 2] = end[2]! * t;
  }
  surface.dirty = true;
  updateSurface(surface);
}

/** Allocate topology once. Only position/normal buffers change during Play. */
export function createCableMesh(scene: Scene, name: string, input: Partial<CableProperties>, simulationId?: number): Mesh {
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
  const surface: CableSurface = { mesh, properties, points: new Float32Array(rings * 3), positions, normals, circle, world: Matrix.Identity(), inverse: Matrix.Identity(), point: new Vector3(), normal: new Vector3(), previewEnd: new Vector3(NaN, NaN, NaN), worldSpace: false, dirty: true };
  surfaces.set(mesh, surface);
  updateCablePreview(mesh, properties.endPosition);
  if (simulationId !== undefined && Number.isSafeInteger(simulationId) && simulationId > 0) {
    let entries = sceneSurfaces.get(scene);
    if (!entries) {
      entries = new Set();
      sceneSurfaces.set(scene, entries);
      const observer = scene.onBeforeRenderObservable.add(() => {
        for (const item of entries) if (item.mesh.isEnabled()) updateSurface(item);
      });
      scene.onDisposeObservable.addOnce(() => {
        scene.onBeforeRenderObservable.remove(observer);
        sceneSurfaces.delete(scene);
        runtimeSurfaces.delete(scene);
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

/** Packed worker records: simulation id, particle count, then world-space xyz. */
export function applyCableFrame(scene: Scene, data: Float32Array): void {
  const entries = runtimeSurfaces.get(scene);
  if (!entries) return;
  for (let offset = 0; offset + 2 <= data.length;) {
    const id = data[offset++]!, count = data[offset++]!;
    if (!Number.isInteger(count) || count < 2 || count > 65 || offset + count * 3 > data.length) return;
    const end = offset + count * 3;
    let finite = true;
    for (let i = offset; i < end; i++) if (!Number.isFinite(data[i])) { finite = false; break; }
    if (finite) for (const surface of entries.get(id) ?? []) {
      if (surface.points.length !== count * 3) continue;
      for (let i = 0; i < surface.points.length; i++) surface.points[i] = data[offset + i]!;
      surface.worldSpace = true;
      surface.dirty = true;
      updateSurface(surface);
    }
    offset = end;
  }
}
