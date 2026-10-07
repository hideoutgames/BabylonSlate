/**
 * Compact triangle-list collision geometry: `positions` holds xyz triples and
 * `indices` triangle corners. Both arrays structured-clone as one memcpy and
 * can be transferred to a worker.
 */
export type CollisionTriangleMesh = {
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
};

/** Uint16 when every vertex fits, otherwise Uint32. */
export function collisionIndexArray(
  indices: ArrayLike<number>,
  vertexCount: number,
): Uint16Array | Uint32Array {
  return vertexCount <= 0x10000 ? Uint16Array.from(indices) : Uint32Array.from(indices);
}

/** Pack object-per-vertex geometry (authored ColliderComponent rows, tessellations). */
export function packCollisionTriangleMesh(
  vertices: ArrayLike<{ x: number; y: number; z: number }>,
  indices: ArrayLike<number>,
): CollisionTriangleMesh {
  const positions = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    const vertex = vertices[i]!;
    positions[i * 3] = vertex.x;
    positions[i * 3 + 1] = vertex.y;
    positions[i * 3 + 2] = vertex.z;
  }
  return { positions, indices: collisionIndexArray(indices, vertices.length) };
}

/** Resident CPU bytes, used for asset-cache memory estimates. */
export function collisionTriangleMeshBytes(mesh: CollisionTriangleMesh): number {
  return mesh.positions.byteLength + mesh.indices.byteLength;
}

/** Element-wise content comparison; only for installation boundaries, never a tick. */
export function sameCollisionTriangleMesh(
  a: CollisionTriangleMesh | null | undefined,
  b: CollisionTriangleMesh | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.positions.length !== b.positions.length || a.indices.length !== b.indices.length) return false;
  for (let i = 0; i < a.positions.length; i++) if (!Object.is(a.positions[i], b.positions[i])) return false;
  for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) return false;
  return true;
}
