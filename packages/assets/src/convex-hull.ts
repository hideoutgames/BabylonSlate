/** 3D convex hull (incremental) for generated simple collision. */

export type HullVec3 = { x: number; y: number; z: number };

export const GENERATED_COLLISION_MAX_POINTS = 64;

/** Closed collision hull triangles, without reducing the authored point cloud. */
export function convexHullMesh(points: readonly HullVec3[]): {
  vertices: HullVec3[];
  indices: number[];
} {
  const vertices = uniquePoints(points);
  const indices = buildHullFaces(vertices).flatMap(({ a, b, c }) => [a, b, c]);
  return { vertices, indices };
}

const EPS = 1e-8;

function sub(a: HullVec3, b: HullVec3): HullVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: HullVec3, b: HullVec3): HullVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: HullVec3, b: HullVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function len2(a: HullVec3): number {
  return dot(a, a);
}

function dist2(a: HullVec3, b: HullVec3): number {
  return len2(sub(a, b));
}

type Face = { a: number; b: number; c: number };

function faceNormal(points: readonly HullVec3[], face: Face): HullVec3 {
  return cross(
    sub(points[face.b]!, points[face.a]!),
    sub(points[face.c]!, points[face.a]!),
  );
}

function volume6(
  points: readonly HullVec3[],
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  return dot(sub(points[d]!, points[a]!), faceNormal(points, { a, b, c }));
}

/**
 * Finite points with near-duplicates (within `eps`) dropped, in input order.
 * Kept points are bucketed in an `eps` grid, so each point is compared only
 * with the kept points in its own and neighbouring cells.
 */
function uniquePoints(points: readonly HullVec3[], eps = 1e-7): HullVec3[] {
  const out: HullVec3[] = [];
  const eps2 = eps * eps;
  const cells = new Map<string, HullVec3[]>();
  for (const point of points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(point.z)
    ) {
      continue;
    }
    const cx = Math.floor(point.x / eps);
    const cy = Math.floor(point.y / eps);
    const cz = Math.floor(point.z / eps);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      for (let dy = -1; dy <= 1 && !duplicate; dy++) {
        for (let dz = -1; dz <= 1 && !duplicate; dz++) {
          duplicate = cells.get(`${cx + dx},${cy + dy},${cz + dz}`)
            ?.some((existing) => dist2(existing, point) <= eps2) ?? false;
        }
      }
    }
    if (duplicate) continue;
    const kept = { x: point.x, y: point.y, z: point.z };
    out.push(kept);
    const key = `${cx},${cy},${cz}`;
    const cell = cells.get(key);
    if (cell) cell.push(kept);
    else cells.set(key, [kept]);
  }
  return out;
}

function orientOutward(
  points: readonly HullVec3[],
  face: Face,
  interior: HullVec3,
): Face {
  const n = faceNormal(points, face);
  if (dot(n, sub(interior, points[face.a]!)) > 0) {
    return { a: face.a, b: face.c, c: face.b };
  }
  return face;
}

function initialTetrahedron(
  points: readonly HullVec3[],
): [number, number, number, number] | null {
  if (points.length < 4) return null;
  // Seed from the farthest pair of axis-extreme points: a long enough base
  // edge in one pass, where comparing every pair is quadratic in the cloud.
  const extremes: number[] = [];
  for (const axis of ["x", "y", "z"] as const) {
    let min = 0;
    let max = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i]![axis] < points[min]![axis]) min = i;
      if (points[i]![axis] > points[max]![axis]) max = i;
    }
    extremes.push(min, max);
  }
  let i0 = 0;
  let i1 = 0;
  let best = 0;
  for (const i of extremes) {
    for (const j of extremes) {
      const d = dist2(points[i]!, points[j]!);
      if (d > best) {
        best = d;
        i0 = i;
        i1 = j;
      }
    }
  }
  if (best < EPS) return null;
  const axis = sub(points[i1]!, points[i0]!);
  let i2 = -1;
  let bestArea = 0;
  for (let i = 0; i < points.length; i++) {
    if (i === i0 || i === i1) continue;
    const area = len2(cross(axis, sub(points[i]!, points[i0]!)));
    if (area > bestArea) {
      bestArea = area;
      i2 = i;
    }
  }
  if (i2 < 0 || bestArea < EPS) return null;
  let i3 = -1;
  let bestVol = 0;
  for (let i = 0; i < points.length; i++) {
    if (i === i0 || i === i1 || i === i2) continue;
    const vol = Math.abs(volume6(points, i0, i1, i2, i));
    if (vol > bestVol) {
      bestVol = vol;
      i3 = i;
    }
  }
  if (i3 < 0 || bestVol < EPS) return null;
  return [i0, i1, i2, i3];
}

function capPoints(points: readonly HullVec3[], max: number): HullVec3[] {
  if (points.length <= max) return [...points];
  const centroid = points.reduce(
    (sum, point) => ({
      x: sum.x + point.x / points.length,
      y: sum.y + point.y / points.length,
      z: sum.z + point.z / points.length,
    }),
    { x: 0, y: 0, z: 0 },
  );
  const remaining = points.map((point, index) => ({ point, index }));
  const chosen: HullVec3[] = [];
  let farthest = remaining[0]!;
  let best = dist2(farthest.point, centroid);
  for (const entry of remaining) {
    const d = dist2(entry.point, centroid);
    if (d > best) {
      best = d;
      farthest = entry;
    }
  }
  chosen.push(farthest.point);
  remaining.splice(
    remaining.findIndex((entry) => entry.index === farthest.index),
    1,
  );
  while (chosen.length < max && remaining.length > 0) {
    let next = remaining[0]!;
    let nextBest = -1;
    for (const entry of remaining) {
      let minD = Infinity;
      for (const keep of chosen) {
        minD = Math.min(minD, dist2(entry.point, keep));
      }
      if (minD > nextBest) {
        nextBest = minD;
        next = entry;
      }
    }
    chosen.push(next.point);
    remaining.splice(
      remaining.findIndex((entry) => entry.index === next.index),
      1,
    );
  }
  return chosen;
}

function buildHullFaces(points: readonly HullVec3[]): Face[] {
  const cloud = points;
  const tetra = initialTetrahedron(cloud);
  if (!tetra) return [];
  const [i0, i1, i2, i3] = tetra;
  const interior = {
    x: (cloud[i0]!.x + cloud[i1]!.x + cloud[i2]!.x + cloud[i3]!.x) / 4,
    y: (cloud[i0]!.y + cloud[i1]!.y + cloud[i2]!.y + cloud[i3]!.y) / 4,
    z: (cloud[i0]!.z + cloud[i1]!.z + cloud[i2]!.z + cloud[i3]!.z) / 4,
  };
  let faces: Face[] = [
    orientOutward(cloud, { a: i0, b: i1, c: i2 }, interior),
    orientOutward(cloud, { a: i0, b: i2, c: i3 }, interior),
    orientOutward(cloud, { a: i0, b: i3, c: i1 }, interior),
    orientOutward(cloud, { a: i1, b: i3, c: i2 }, interior),
  ];
  const used = new Set(tetra);
  for (let index = 0; index < cloud.length; index++) {
    if (used.has(index)) continue;
    const point = cloud[index]!;
    const visible: number[] = [];
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f]!;
      const n = faceNormal(cloud, face);
      const n2 = len2(n);
      if (n2 < EPS) continue;
      if (dot(n, sub(point, cloud[face.a]!)) > Math.sqrt(n2) * 1e-6) {
        visible.push(f);
      }
    }
    if (visible.length === 0) continue;
    const visibleSet = new Set(visible);
    const edgeCount = new Map<string, [number, number]>();
    const addEdge = (a: number, b: number) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edgeCount.has(key)) edgeCount.delete(key);
      else edgeCount.set(key, [a, b]);
    };
    for (const f of visible) {
      const face = faces[f]!;
      addEdge(face.a, face.b);
      addEdge(face.b, face.c);
      addEdge(face.c, face.a);
    }
    faces = faces.filter((_, f) => !visibleSet.has(f));
    for (const [a, b] of edgeCount.values()) {
      faces.push(orientOutward(cloud, { a, b, c: index }, interior));
    }
    used.add(index);
  }
  return faces;
}

/** Unique hull vertices. Empty when the cloud is degenerate (no volume). */
export function convexHull3d(
  points: readonly HullVec3[],
  maxPoints = GENERATED_COLLISION_MAX_POINTS,
): HullVec3[] {
  const cloud = uniquePoints(points);
  const faces = buildHullFaces(cloud);
  if (faces.length === 0) return [];
  const hull: HullVec3[] = [];
  const seen = new Set<number>();
  for (const face of faces) {
    for (const index of [face.a, face.b, face.c]) {
      if (seen.has(index)) continue;
      seen.add(index);
      hull.push(cloud[index]!);
    }
  }
  return capPoints(hull, maxPoints);
}

export function convexHullEdges(
  points: readonly HullVec3[],
): Array<[HullVec3, HullVec3]> {
  const cloud = uniquePoints(points);
  const faces = buildHullFaces(cloud);
  const edges: Array<[HullVec3, HullVec3]> = [];
  const seen = new Set<string>();
  for (const face of faces) {
    const loop: Array<[number, number]> = [
      [face.a, face.b],
      [face.b, face.c],
      [face.c, face.a],
    ];
    for (const [a, b] of loop) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([cloud[a]!, cloud[b]!]);
    }
  }
  return edges;
}
