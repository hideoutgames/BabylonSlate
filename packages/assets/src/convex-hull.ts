/** 3D convex hull (incremental) for generated simple collision. */

export type HullVec3 = { x: number; y: number; z: number };

export const GENERATED_COLLISION_MAX_POINTS = 64;

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

function uniquePoints(points: readonly HullVec3[], eps = 1e-7): HullVec3[] {
  const out: HullVec3[] = [];
  const eps2 = eps * eps;
  for (const point of points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(point.z)
    ) {
      continue;
    }
    if (out.some((existing) => dist2(existing, point) <= eps2)) continue;
    out.push({ x: point.x, y: point.y, z: point.z });
  }
  return out;
}

function orientOutward(points: readonly HullVec3[], face: Face, interior: HullVec3): Face {
  const n = faceNormal(points, face);
  if (dot(n, sub(interior, points[face.a]!)) > 0) {
    return { a: face.a, b: face.c, c: face.b };
  }
  return face;
}

function initialTetrahedron(points: readonly HullVec3[]): [number, number, number, number] | null {
  if (points.length < 4) return null;
  let i0 = 0;
  let i1 = 1;
  let best = dist2(points[0]!, points[1]!);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
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
