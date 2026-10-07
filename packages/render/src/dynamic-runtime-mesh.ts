import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { DynamicMeshRange, DynamicMeshUpdate } from "@babylonslate/core";
import { updateDynamicMaterialBounds } from "./material-bounds";

type Channel = { kind: string; data: Float32Array; start: number; end: number };
type InitialGeometry = { meshId: number; update: DynamicMeshUpdate };
type Surface = {
  mesh: Mesh; revision: number; channels: [Channel, Channel, Channel]; indices: Uint32Array;
  verticesResized: boolean; indicesResized: boolean; indicesDirty: boolean;
  minimum: Vector3; maximum: Vector3;
  initial?: InitialGeometry;
};
type SceneState = { surfaces: Map<number, Set<Surface>>; dirty: Set<Surface> };
const scenes = new WeakMap<Scene, SceneState>();
const surfaces = new WeakMap<Mesh, Surface>();

/** Owned buffer mutations publish revisions, allowing unchanged shadow maps to stay cached. */
export function hasRevisionTrackedDynamicMesh(mesh: Mesh): boolean {
  const state = surfaces.get(mesh);
  if (state && !state.indices.length && !mesh.geometry) return true;
  return !!state && state.channels.every((channel) => mesh.getVerticesData(channel.kind) === channel.data) && mesh.getIndices() === state.indices;
}

function sceneState(scene: Scene): SceneState {
  let state = scenes.get(scene);
  if (!state) {
    state = { surfaces: new Map(), dirty: new Set() };
    scenes.set(scene, state);
    const observer = scene.onBeforeRenderObservable.add(() => flushDynamicRuntimeMeshes(scene), -1, true);
    scene.onDisposeObservable.addOnce(() => {
      scene.onBeforeRenderObservable.remove(observer);
      state!.dirty.clear(); state!.surfaces.clear(); scenes.delete(scene);
    });
  }
  return state;
}

export function createDynamicRuntimeMesh(scene: Scene, name: string, initial?: InitialGeometry): Mesh {
  const mesh = new Mesh(name, scene);
  const channel = (kind: string): Channel => ({ kind, data: new Float32Array(0), start: Infinity, end: 0 });
  const surface: Surface = { mesh, initial, revision: -1, channels: [channel(VertexBuffer.PositionKind), channel(VertexBuffer.NormalKind), channel(VertexBuffer.UVKind)],
    indices: new Uint32Array(0), verticesResized: false, indicesResized: false, indicesDirty: false, minimum: new Vector3(), maximum: new Vector3() };
  surfaces.set(mesh, surface);
  if (initial) {
    const state = sceneState(scene);
    let matching = state.surfaces.get(initial.meshId);
    if (!matching) { matching = new Set(); state.surfaces.set(initial.meshId, matching); }
    matching.add(surface);
    applyUpdate(surface, initial.update);
    flushSurface(surface);
    mesh.onDisposeObservable.addOnce(() => {
      matching!.delete(surface); state.dirty.delete(surface);
      if (!matching!.size) state.surfaces.delete(initial.meshId);
      surfaces.delete(mesh);
    });
  }
  return mesh;
}

/** No GPU work here: all packets arriving before a render share one upload per dirty channel. */
export function applyDynamicRuntimeMeshUpdate(scene: Scene, meshId: number, update: DynamicMeshUpdate): void {
  const state = scenes.get(scene);
  const matching = state?.surfaces.get(meshId);
  if (!state || !matching) return;
  for (const surface of matching) if (applyUpdate(surface, update)) state.dirty.add(surface);
}

function applyUpdate(surface: Surface, update: DynamicMeshUpdate): boolean {
  if (update.revision <= surface.revision || surface.mesh.isDisposed()) return false;
  const [positions, normals, uvs] = surface.channels;
  if (!update.reset && (update.vertexCount * 3 !== positions.data.length || update.indexCount !== surface.indices.length)) return false;
  if (update.reset) {
    if (positions.data.length !== update.vertexCount * 3) {
      positions.data = new Float32Array(update.vertexCount * 3);
      normals.data = new Float32Array(update.vertexCount * 3);
      uvs.data = new Float32Array(update.vertexCount * 2);
      surface.verticesResized = true;
    }
    if (surface.indices.length !== update.indexCount) {
      surface.indices = new Uint32Array(update.indexCount);
      surface.indicesResized = true;
    }
    // Superseded pending ranges must not extend past a smaller replacement.
    for (const channel of surface.channels) { channel.start = Infinity; channel.end = 0; }
  }
  const write = (channel: Channel, range: DynamicMeshRange | undefined) => {
    if (!range || !range.data.length) return;
    channel.data.set(range.data, range.offset);
    channel.start = Math.min(channel.start, range.offset);
    channel.end = Math.max(channel.end, range.offset + range.data.length);
  };
  write(positions, update.positions); write(normals, update.normals); write(uvs, update.uvs);
  if (update.indices) { surface.indices.set(update.indices); surface.indicesDirty = true; }
  surface.minimum.copyFromFloats(...update.bounds.min); surface.maximum.copyFromFloats(...update.bounds.max);
  surface.revision = update.revision;
  // Slot migration and staged visual replacement can recreate this component
  // without a new runtime assignment. Retain current owned arrays, not its first packet.
  if (surface.initial) surface.initial.update = {
    revision: update.revision, vertexCount: update.vertexCount, indexCount: update.indexCount, reset: true,
    positions: { offset: 0, data: positions.data }, normals: { offset: 0, data: normals.data },
    uvs: { offset: 0, data: uvs.data }, indices: surface.indices,
    bounds: { min: [...update.bounds.min], max: [...update.bounds.max] },
  };
  return true;
}

export function flushDynamicRuntimeMeshes(scene: Scene): void {
  const state = scenes.get(scene);
  if (!state) return;
  for (const surface of state.dirty) if (!surface.mesh.isDisposed()) flushSurface(surface);
  state.dirty.clear();
}

function flushSurface(surface: Surface): void {
  const { mesh } = surface;
  if (!surface.indices.length) {
    mesh.geometry?.dispose();
    surface.verticesResized = false; surface.indicesResized = false; surface.indicesDirty = false;
    return;
  }
  const engine = mesh.getEngine();
  const newGeometry = !mesh.geometry;
  for (const channel of surface.channels) {
    if (surface.verticesResized || newGeometry) mesh.setVerticesData(channel.kind, channel.data, true);
    else if (channel.end > channel.start) {
      // Keep Babylon's CPU array for picking and context restoration. Its direct-buffer
      // helper discards that array; the engine's public upload preserves our owned copy.
      const buffer = mesh.getVertexBuffer(channel.kind)!.getBuffer()!;
      const data = channel.data.subarray(channel.start, channel.end);
      engine.updateDynamicVertexBuffer(buffer, data, channel.start * Float32Array.BYTES_PER_ELEMENT, data.byteLength);
    }
    channel.start = Infinity; channel.end = 0;
  }
  if (surface.indicesResized || surface.verticesResized || newGeometry) mesh.setIndices(surface.indices, null, true);
  else if (surface.indicesDirty) mesh.updateIndices(surface.indices, 0, true);
  const geometry = mesh.geometry!;
  geometry._resetPointsArrayCache(); // Babylon 9.29: invalidate its lazily cached picking positions.
  geometry.extend.minimum.copyFrom(surface.minimum); geometry.extend.maximum.copyFrom(surface.maximum);
  updateDynamicMaterialBounds(mesh, surface.minimum, surface.maximum);
  geometry.onGeometryUpdated?.(geometry);
  surface.verticesResized = false; surface.indicesResized = false; surface.indicesDirty = false;
}
