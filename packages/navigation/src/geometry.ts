export type NavBakeVertex = { x: number; y: number; z: number };

export type NavBakeMeshPart = {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  transform?: (x: number, y: number, z: number) => NavBakeVertex;
};

export type NavBakeGeometry = {
  positions: number[];
  indices: number[];
};

/** Concatenate world-space triangles for Recast generate. */
export function mergeNavBakeMeshes(
  parts: readonly NavBakeMeshPart[],
): NavBakeGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const part of parts) {
    const count = Math.floor(part.positions.length / 3);
    for (let i = 0; i < count; i += 1) {
      const x = Number(part.positions[i * 3] ?? 0);
      const y = Number(part.positions[i * 3 + 1] ?? 0);
      const z = Number(part.positions[i * 3 + 2] ?? 0);
      const mapped = part.transform ? part.transform(x, y, z) : { x, y, z };
      positions.push(mapped.x, mapped.y, mapped.z);
    }
    for (let i = 0; i < part.indices.length; i += 1) {
      indices.push(Number(part.indices[i] ?? 0) + vertexOffset);
    }
    vertexOffset += count;
  }
  return { positions, indices };
}
