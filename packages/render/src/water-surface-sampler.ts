type Bounds = { minX: number; minZ: number; maxX: number; maxZ: number };
type Triangle = Bounds & { a: number; b: number; c: number; aX: number; aZ: number; bX: number; bZ: number };
type Node = Bounds & ({ triangles: Triangle[] } | { left: Node; right: Node });

function tree(triangles: Triangle[]): Node {
  const bounds: Bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const triangle of triangles) {
    bounds.minX = Math.min(bounds.minX, triangle.minX); bounds.minZ = Math.min(bounds.minZ, triangle.minZ);
    bounds.maxX = Math.max(bounds.maxX, triangle.maxX); bounds.maxZ = Math.max(bounds.maxZ, triangle.maxZ);
  }
  if (triangles.length <= 8) return { ...bounds, triangles };
  // Equal-sized partitions keep depth bounded even when Global Water concentrates cells near the camera.
  const alongX = bounds.maxX - bounds.minX >= bounds.maxZ - bounds.minZ;
  triangles.sort((a, b) => alongX ? a.minX + a.maxX - b.minX - b.maxX : a.minZ + a.maxZ - b.minZ - b.maxZ);
  const middle = Math.floor(triangles.length / 2);
  return { ...bounds, left: tree(triangles.slice(0, middle)), right: tree(triangles.slice(middle)) };
}

const contains = (bounds: Bounds, x: number, z: number) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;

/** Samples the rendered triangles, including their spacing-filtered waves, without resampling analytic waves. */
export class WaterSurfaceSampler {
  private readonly root: Node;

  constructor(private readonly base: Float32Array, private readonly waterData: Float32Array, indices: ArrayLike<number>) {
    const triangles: Triangle[] = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
      const ax = base[a]!, az = base[a + 2]!, bx = base[b]!, bz = base[b + 2]!, cx = base[c]!, cz = base[c + 2]!;
      const determinant = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(determinant) < 1e-12) continue;
      triangles.push({
        a, b, c, minX: Math.min(ax, bx, cx), minZ: Math.min(az, bz, cz), maxX: Math.max(ax, bx, cx), maxZ: Math.max(az, bz, cz),
        aX: (bz - cz) / determinant, aZ: (cx - bx) / determinant, bX: (cz - az) / determinant, bZ: (ax - cx) / determinant,
      });
    }
    this.root = tree(triangles);
  }

  /** Wave heights stay live; only a layout or transform change requires rebuilding the spatial index. */
  heightAt(x: number, z: number): number | null {
    return this.sample(this.root, x, z);
  }

  private sample(node: Node, x: number, z: number): number | null {
    if (!contains(node, x, z)) return null;
    if (!("triangles" in node)) {
      const a = this.sample(node.left, x, z), b = this.sample(node.right, x, z);
      return a === null ? b : b === null ? a : Math.max(a, b);
    }
    let height: number | null = null;
    for (const triangle of node.triangles) {
      if (!contains(triangle, x, z)) continue;
      const dx = x - this.base[triangle.c]!, dz = z - this.base[triangle.c + 2]!;
      const a = triangle.aX * dx + triangle.aZ * dz, b = triangle.bX * dx + triangle.bZ * dz, c = 1 - a - b;
      if (a < -1e-7 || b < -1e-7 || c < -1e-7) continue;
      const y = a * this.vertexHeight(triangle.a) + b * this.vertexHeight(triangle.b) + c * this.vertexHeight(triangle.c);
      height = height === null ? y : Math.max(height, y);
    }
    return height;
  }

  private vertexHeight(index: number): number {
    return this.base[index + 1]! + this.waterData[index / 3 * 4]!;
  }
}
