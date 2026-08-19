import type { NavBakeMeshPart } from "./geometry";
import { worldToRecast } from "./remap";
import type { NavObstacleKind, NavPoint } from "./types";

export type NavBlockerArea = "unwalkable" | "cost";

export type SolidBlockerInput = {
  kind: NavObstacleKind;
  pose: NavPoint;
  size: NavPoint;
  /** World quaternion. Missing is identity (axis-aligned). */
  rotation?: { x: number; y: number; z: number; w: number };
};

export type XyBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type XyChain = {
  points: Array<{ x: number; y: number }>;
  loop: boolean;
};

const BOX_FACE_QUADS: Array<[number, number, number, number]> = [
  [0, 1, 2, 3],
  [5, 4, 7, 6],
  [4, 0, 3, 7],
  [1, 5, 6, 2],
  [3, 2, 6, 7],
  [4, 5, 1, 0],
];

function pushQuad(
  positions: number[],
  indices: number[],
  corners: NavPoint[],
): void {
  const base = positions.length / 3;
  for (const corner of corners) {
    positions.push(corner.x, corner.y, corner.z);
  }
  indices.push(
    base + 0,
    base + 3,
    base + 2,
    base + 0,
    base + 2,
    base + 1,
  );
}

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

function rotatePoint(
  rotation: { x: number; y: number; z: number; w: number },
  point: NavPoint,
): NavPoint {
  const { x: qx, y: qy, z: qz, w: qw } = rotation;
  const tx = 2 * (qy * point.z - qz * point.y);
  const ty = 2 * (qz * point.x - qx * point.z);
  const tz = 2 * (qx * point.y - qy * point.x);
  return {
    x: point.x + qw * tx + (qy * tz - qz * ty),
    y: point.y + qw * ty + (qz * tx - qx * tz),
    z: point.z + qw * tz + (qx * ty - qy * tx),
  };
}

function addPoint(a: NavPoint, b: NavPoint): NavPoint {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function asRotation(
  value: { x: number; y: number; z: number; w: number } | undefined,
): { x: number; y: number; z: number; w: number } {
  if (!value) return IDENTITY_ROTATION;
  const { x, y, z, w } = value;
  if (![x, y, z, w].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return IDENTITY_ROTATION;
  }
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-8) return IDENTITY_ROTATION;
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

/** World AABB of a box whose local size is `scale` and whose center is `position`. */
export function rotatedBoxWorldAabb(
  position: [number, number, number],
  rotation: [number, number, number, number],
  scale: [number, number, number],
): { center: NavPoint; size: NavPoint; min: NavPoint; max: NavPoint } {
  const hx = Math.abs(scale[0] ?? 1) / 2;
  const hy = Math.abs(scale[1] ?? 1) / 2;
  const hz = Math.abs(scale[2] ?? 1) / 2;
  const quat = asRotation({
    x: rotation[0] ?? 0,
    y: rotation[1] ?? 0,
    z: rotation[2] ?? 0,
    w: rotation[3] ?? 1,
  });
  const origin = { x: position[0], y: position[1], z: position[2] };
  const signs: Array<[number, number, number]> = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const [sx, sy, sz] of signs) {
    const world = addPoint(
      origin,
      rotatePoint(quat, { x: sx * hx, y: sy * hy, z: sz * hz }),
    );
    minX = Math.min(minX, world.x);
    minY = Math.min(minY, world.y);
    minZ = Math.min(minZ, world.z);
    maxX = Math.max(maxX, world.x);
    maxY = Math.max(maxY, world.y);
    maxZ = Math.max(maxZ, world.z);
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    },
    size: {
      x: Math.max(0.05, maxX - minX),
      y: Math.max(0.05, maxY - minY),
      z: Math.max(0.05, maxZ - minZ),
    },
  };
}

function transformLocalPoint(
  pose: NavPoint,
  rotation: { x: number; y: number; z: number; w: number } | undefined,
  local: NavPoint,
): NavPoint {
  return addPoint(pose, rotatePoint(asRotation(rotation), local));
}

function boxMesh(
  pose: NavPoint,
  size: NavPoint,
  rotation?: { x: number; y: number; z: number; w: number },
): {
  positions: number[];
  indices: number[];
} {
  const hx = Math.max(size.x, 0.05) / 2;
  const hy = Math.max(size.y, 0.05) / 2;
  const hz = Math.max(size.z, 0.05) / 2;
  const local: NavPoint[] = [
    { x: -hx, y: -hy, z: -hz },
    { x: hx, y: -hy, z: -hz },
    { x: hx, y: hy, z: -hz },
    { x: -hx, y: hy, z: -hz },
    { x: -hx, y: -hy, z: hz },
    { x: hx, y: -hy, z: hz },
    { x: hx, y: hy, z: hz },
    { x: -hx, y: hy, z: hz },
  ];
  const verts = local.map((point) => transformLocalPoint(pose, rotation, point));
  const positions: number[] = [];
  const indices: number[] = [];
  for (const face of BOX_FACE_QUADS) {
    pushQuad(positions, indices, [
      verts[face[0]]!,
      verts[face[1]]!,
      verts[face[2]]!,
      verts[face[3]]!,
    ]);
  }
  return { positions, indices };
}

function cylinderMesh(
  pose: NavPoint,
  size: NavPoint,
  rotation?: { x: number; y: number; z: number; w: number },
): {
  positions: number[];
  indices: number[];
} {
  const radius = Math.max(size.x, 0.05);
  const height = Math.max(size.y, 0.05);
  const segments = 12;
  const y0 = -height / 2;
  const y1 = height / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  const ring: NavPoint[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push({
      x: Math.cos(angle) * radius,
      y: 0,
      z: Math.sin(angle) * radius,
    });
  }
  const world = (local: NavPoint) => transformLocalPoint(pose, rotation, local);
  for (let i = 0; i < segments; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % segments]!;
    pushQuad(positions, indices, [
      world({ x: a.x, y: y0, z: a.z }),
      world({ x: b.x, y: y0, z: b.z }),
      world({ x: b.x, y: y1, z: b.z }),
      world({ x: a.x, y: y1, z: a.z }),
    ]);
  }
  const bottom: NavPoint[] = [];
  const top: NavPoint[] = [];
  for (const point of ring) {
    bottom.push(world({ x: point.x, y: y0, z: point.z }));
    top.push(world({ x: point.x, y: y1, z: point.z }));
  }
  for (let i = 1; i < segments - 1; i += 1) {
    const base = positions.length / 3;
    positions.push(
      bottom[0]!.x,
      bottom[0]!.y,
      bottom[0]!.z,
      bottom[i]!.x,
      bottom[i]!.y,
      bottom[i]!.z,
      bottom[i + 1]!.x,
      bottom[i + 1]!.y,
      bottom[i + 1]!.z,
    );
    indices.push(base, base + 2, base + 1);
    const topBase = positions.length / 3;
    positions.push(
      top[0]!.x,
      top[0]!.y,
      top[0]!.z,
      top[i]!.x,
      top[i]!.y,
      top[i]!.z,
      top[i + 1]!.x,
      top[i + 1]!.y,
      top[i + 1]!.z,
    );
    indices.push(topBase, topBase + 1, topBase + 2);
  }
  return { positions, indices };
}

/** Closed solid Recast can voxelise as a carve (static unwalkable blocker). */
export function solidBlockerMesh(input: SolidBlockerInput): {
  positions: number[];
  indices: number[];
} {
  if (input.kind === "cylinder") {
    return cylinderMesh(input.pose, input.size, input.rotation);
  }
  return boxMesh(input.pose, input.size, input.rotation);
}

/** Recast XZ walkable quad from a 2D XY bounds. Recast Y is up. */
export function recastWalkableQuadFromXy(bounds: XyBounds): {
  positions: number[];
  indices: number[];
} {
  const min = worldToRecast({ x: bounds.minX, y: bounds.minY, z: 0 });
  const max = worldToRecast({ x: bounds.maxX, y: bounds.maxY, z: 0 });
  return {
    positions: [
      min.x, 0, min.z,
      max.x, 0, min.z,
      max.x, 0, max.z,
      min.x, 0, max.z,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

/** Extrude XY polylines into Recast XZ walls of `height` (Recast Y). */
export function recastWallsFromXyChains(
  chains: readonly XyChain[],
  height: number,
): { positions: number[]; indices: number[] } {
  const wallHeight = Math.max(height, 0.05);
  const thickness = 0.8;
  const parts: Array<{ positions: number[]; indices: number[] }> = [];
  for (const chain of chains) {
    if (chain.points.length < 2) continue;
    const count = chain.loop ? chain.points.length : chain.points.length - 1;
    for (let i = 0; i < count; i += 1) {
      const a = chain.points[i]!;
      const b = chain.points[(i + 1) % chain.points.length]!;
      const from = worldToRecast({ x: a.x, y: a.y, z: 0 });
      const to = worldToRecast({ x: b.x, y: b.y, z: 0 });
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const nx = Math.abs(-dz / length);
      const nz = Math.abs(dx / length);
      parts.push(
        solidBlockerMesh({
          kind: "box",
          pose: {
            x: (from.x + to.x) / 2,
            y: wallHeight / 2,
            z: (from.z + to.z) / 2,
          },
          size: {
            x: Math.abs(dx) + thickness * nx,
            y: wallHeight,
            z: Math.abs(dz) + thickness * nz,
          },
        }),
      );
    }
  }
  const positions: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const part of parts) {
    positions.push(...part.positions);
    for (const index of part.indices) indices.push(index + offset);
    offset += part.positions.length / 3;
  }
  return { positions, indices };
}

export type BlockerActorBakeInput = {
  transform: {
    position: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  };
  components: Array<{ classId: string; properties: Record<string, unknown> }>;
};

export type NavBakeBounds = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function aabbIntersects(
  minA: { x: number; y: number; z: number },
  maxA: { x: number; y: number; z: number },
  bounds: NavBakeBounds,
): boolean {
  const minX = Math.min(bounds.min.x, bounds.max.x);
  const maxX = Math.max(bounds.min.x, bounds.max.x);
  const minY = Math.min(bounds.min.y, bounds.max.y);
  const maxY = Math.max(bounds.min.y, bounds.max.y);
  const minZ = Math.min(bounds.min.z, bounds.max.z);
  const maxZ = Math.max(bounds.min.z, bounds.max.z);
  return (
    minA.x <= maxX &&
    maxA.x >= minX &&
    minA.y <= maxY &&
    maxA.y >= minY &&
    minA.z <= maxZ &&
    maxA.z >= minZ
  );
}

function recastRotationFromWorld(
  rotation: [number, number, number, number] | undefined,
  viewportMode: "2d" | "3d",
): { x: number; y: number; z: number; w: number } {
  const quat = asRotation(
    rotation
      ? { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }
      : undefined,
  );
  if (viewportMode !== "2d") return quat;
  return { x: quat.x, y: quat.z, z: quat.y, w: quat.w };
}

function blockerIntersectsBakeBounds(
  position: [number, number, number],
  rotation: [number, number, number, number] | undefined,
  scale: [number, number, number],
  viewportMode: "2d" | "3d",
  bounds: NavBakeBounds,
): boolean {
  const quat = rotation ?? [0, 0, 0, 1];
  const aabb = rotatedBoxWorldAabb(position, quat, scale);
  if (viewportMode === "2d") {
    return aabbIntersects(
      { x: aabb.min.x, y: aabb.min.y, z: -1 },
      { x: aabb.max.x, y: aabb.max.y, z: 1 },
      bounds,
    );
  }
  return aabbIntersects(aabb.min, aabb.max, bounds);
}

/** Static unwalkable blockers become bake solids. Dynamic / cost are skipped. */
export function staticBlockerBakeParts(
  actors: readonly BlockerActorBakeInput[],
  viewportMode: "2d" | "3d",
  bakeBounds?: NavBakeBounds,
): NavBakeMeshPart[] {
  const parts: NavBakeMeshPart[] = [];
  for (const actor of actors) {
    for (const component of actor.components) {
      if (component.classId !== "NavMeshBlockerComponent") continue;
      if (asBoolean(component.properties.dynamic, false)) continue;
      if (component.properties.area === "cost") continue;
      const kind: NavObstacleKind =
        component.properties.kind === "cylinder" ? "cylinder" : "box";
      const position = actor.transform.position;
      const rotation = actor.transform.rotation ?? [0, 0, 0, 1];
      const scale = actor.transform.scale ?? [1, 1, 1];
      if (
        bakeBounds &&
        !blockerIntersectsBakeBounds(
          position,
          rotation,
          scale,
          viewportMode,
          bakeBounds,
        )
      ) {
        continue;
      }
      if (viewportMode === "2d") {
        const recast = worldToRecast({
          x: position[0],
          y: position[1],
          z: 0,
        });
        parts.push(
          solidBlockerMesh({
            kind,
            pose: { x: recast.x, y: 1, z: recast.z },
            size: {
              x: Math.abs(scale[0] ?? 1),
              y: 2,
              z: Math.abs(scale[1] ?? 1),
            },
            rotation: recastRotationFromWorld(rotation, "2d"),
          }),
        );
      } else {
        parts.push(
          solidBlockerMesh({
            kind,
            pose: { x: position[0], y: position[1], z: position[2] },
            size: {
              x: Math.abs(scale[0] ?? 1),
              y: Math.abs(scale[1] ?? 1),
              z: Math.abs(scale[2] ?? 1),
            },
            rotation: recastRotationFromWorld(rotation, "3d"),
          }),
        );
      }
    }
  }
  return parts;
}

export function xyBoundsFromActors(
  actors: readonly BlockerActorBakeInput[],
  pad = 8,
): XyBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const actor of actors) {
    const [x, y] = actor.transform.position;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) {
    return { minX: -pad, minY: -pad, maxX: pad, maxY: pad };
  }
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

/** 2D ColliderComponent shapes as Recast walls / solids. */
export function recastMeshesFromCollider2d(
  position: { x: number; y: number },
  shape: Record<string, unknown> | undefined,
  height = 2,
): NavBakeMeshPart[] {
  if (!shape) return [];
  const kind = typeof shape.kind === "string" ? shape.kind : "box2d";
  if (kind === "chain" || kind === "polygon") {
    const points = Array.isArray(shape.points)
      ? shape.points
          .map((point) => {
            if (!point || typeof point !== "object") return null;
            const row = point as { x?: unknown; y?: unknown };
            if (typeof row.x !== "number" || typeof row.y !== "number") return null;
            return { x: row.x + position.x, y: row.y + position.y };
          })
          .filter((point): point is { x: number; y: number } => point !== null)
      : [];
    if (points.length < 2) return [];
    return [
      recastWallsFromXyChains(
        [{ points, loop: kind === "polygon" || shape.loop === true }],
        height,
      ),
    ];
  }
  if (kind === "circle") {
    const radius =
      typeof shape.radius === "number" && Number.isFinite(shape.radius)
        ? shape.radius
        : 0.5;
    const recast = worldToRecast({ x: position.x, y: position.y, z: 0 });
    return [
      solidBlockerMesh({
        kind: "cylinder",
        pose: { x: recast.x, y: 0, z: recast.z },
        size: { x: radius, y: height, z: radius },
      }),
    ];
  }
  const half = (shape.halfExtents ?? {}) as { x?: unknown; y?: unknown };
  const hx = typeof half.x === "number" ? half.x : 0.5;
  const hy = typeof half.y === "number" ? half.y : 0.5;
  const recast = worldToRecast({ x: position.x, y: position.y, z: 0 });
  return [
    solidBlockerMesh({
      kind: "box",
      pose: { x: recast.x, y: height / 2, z: recast.z },
      size: { x: hx * 2, y: height, z: hy * 2 },
    }),
  ];
}
