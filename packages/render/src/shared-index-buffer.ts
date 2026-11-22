import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

/** Babylon keeps a Geometry's GPU index buffer private; a Geometry creates it when first applied to a mesh. */
type GeometryIndexBuffer = { _indexBuffer: DataBuffer | null };

/**
 * Per Engine, the GPU index buffer last made for each CPU index array. The map holds no reference: each Geometry that
 * draws a buffer holds one (`DataBuffer.references`) and releases it when it is disposed or given other indices, so
 * the buffer is deleted with its last Geometry, in whatever order they go. A restored context starts a new map: the
 * buffers of the lost one are gone, and Babylon rebuilds every Geometry that has meshes with a buffer of its own.
 */
const buffersByEngine = new WeakMap<AbstractEngine, WeakMap<object, DataBuffer>>();

function buffersOf(engine: AbstractEngine): WeakMap<object, DataBuffer> {
  let buffers = buffersByEngine.get(engine);
  if (!buffers) {
    buffersByEngine.set(engine, (buffers = new WeakMap()));
    engine.onContextRestoredObservable.add(() => buffersByEngine.set(engine, new WeakMap()));
  }
  return buffers;
}

/**
 * Applies `geometry` to `mesh`, drawing with the GPU index buffer of every other Geometry applied this way from the
 * same CPU index array (the same Model primitive or level of detail), instead of uploading one of its own. Thin
 * instances keep their attributes on the Geometry, so meshes that draw one primitive at many places each need their
 * own Geometry; their indices need not be copied. The Geometry keeps the CPU array (`getIndices`, picking).
 */
export function applyWithSharedIndices(geometry: Geometry, mesh: Mesh): void {
  const indices = geometry.getIndices(false, false);
  const owned = geometry as unknown as GeometryIndexBuffer;
  if (!indices?.length || owned._indexBuffer) {
    geometry.applyToMesh(mesh);
    return;
  }
  const buffers = buffersOf(geometry.getEngine());
  const shared = buffers.get(indices);
  // A buffer whose last Geometry released it is deleted.
  const live = shared !== undefined && shared.references > 0;
  if (live) {
    shared.references += 1;
    owned._indexBuffer = shared;
  }
  geometry.applyToMesh(mesh);
  if (!live) {
    const made = geometry.getIndexBuffer();
    if (made) buffers.set(indices, made);
  }
}

/**
 * Forgets the GPU index buffer of a Geometry no mesh draws, after a lost context was restored: Babylon rebuilds only
 * the buffers of Geometries with meshes, so this one's is gone, and applying it again makes a new one.
 */
export function forgetLostIndexBuffer(geometry: Geometry): void {
  (geometry as unknown as GeometryIndexBuffer)._indexBuffer = null;
}
