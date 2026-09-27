import { describe, expect, it } from "vitest";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import { simplifyLevels } from "./model-lod-simplify";

/** A flat-shaded cube with n × n quads per face; each face has its own vertices, as glTF exporters emit. */
function subdividedCube(n: number) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]] as const;
  for (const [a, b, c, side] of faces) {
    const base = positions.length / 3;
    for (let row = 0; row <= n; row++) {
      for (let column = 0; column <= n; column++) {
        const position = [0, 0, 0];
        position[a] = (column / n) * 2 - 1;
        position[b] = (row / n) * 2 - 1;
        position[c] = side;
        positions.push(...position);
        const normal = [0, 0, 0];
        normal[c] = side;
        normals.push(...normal);
        uvs.push(column / n, row / n);
      }
    }
    for (let row = 0; row < n; row++) {
      for (let column = 0; column < n; column++) {
        const v = base + row * (n + 1) + column;
        const w = v + n + 1;
        if (side > 0) indices.push(v, w, v + 1, v + 1, w, w + 1);
        else indices.push(v, v + 1, w, v + 1, w + 1, w);
      }
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

describe("automatic LOD simplification", () => {
  it("keeps the levels of over-tessellated flat parts that reach the triangle floor", async () => {
    await MeshoptSimplifier.ready;
    const cube = subdividedCube(32);
    const half = cube.indices.length / 2;
    for (const ranges of [[cube.indices], [cube.indices.slice(0, half), cube.indices.slice(half)]]) {
      const levels = simplifyLevels(MeshoptSimplifier, { ...cube, ranges, deforming: false });
      expect(levels.length).toBeGreaterThan(0);
      // Flat faces collapse to a small fraction of the source triangles.
      expect(levels.at(-1)!.triangles).toBeLessThan(cube.indices.length / 3 / 10);
    }
  });
});
