import type { NavBakeMeshPart } from "./geometry";
import { recastToWorld, worldToRecast } from "./remap";
import type { NavObstacleKind, NavPoint } from "./types";

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

/** Upright (elliptic) cylinder whose X/Z size are diameters, like the editor's unit cylinder scaled by the actor. */
function cylinderMesh(
  pose: NavPoint,
  size: NavPoint,
  rotation?: { x: number; y: number; z: number; w: number },
): {
  positions: number[];
  indices: number[];
} {
  const radiusX = Math.max(size.x, 0.05) / 2;
  const radiusZ = Math.max(size.z, 0.05) / 2;
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
      x: Math.cos(angle) * radiusX,
      y: 0,
      z: Math.sin(angle) * radiusZ,
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

/**
 * Closed solid Recast can voxelise as a carve (static unwalkable blocker).
 * `pose` is the center and `size` the full extent; a cylinder stands on Y and
 * its X/Z sizes are diameters.
 */
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
  /** With `parentId`, places a child under its parent's world transform. */
  id?: string;
  parentId?: string | null;
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

/** Row-major 3x4 affine transform: rotation-scale columns plus translation. */
type Affine = readonly number[];

function trsAffine(
  position: readonly number[],
  rotation: readonly number[] | undefined,
  scale: readonly number[] | undefined,
): Affine {
  const { x, y, z, w } = asRotation(
    rotation ? { x: rotation[0]!, y: rotation[1]!, z: rotation[2]!, w: rotation[3]! } : undefined,
  );
  const sx = scale?.[0] ?? 1;
  const sy = scale?.[1] ?? 1;
  const sz = scale?.[2] ?? 1;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, position[0] ?? 0,
    2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, position[1] ?? 0,
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, position[2] ?? 0,
  ];
}

/** `outer` applied after `inner`. */
function multiplyAffine(outer: Affine, inner: Affine): Affine {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let value = column === 3 ? outer[row * 4 + 3]! : 0;
      for (let k = 0; k < 3; k += 1) value += outer[row * 4 + k]! * inner[k * 4 + column]!;
      out.push(value);
    }
  }
  return out;
}

function applyAffine(m: Affine, x: number, y: number, z: number): NavPoint {
  return {
    x: m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
    y: m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
    z: m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
  };
}

/** The blocker's world transform through its parent chain, as the editor and Play compose it. */
function blockerWorldAffine(
  actor: BlockerActorBakeInput,
  actorsById: ReadonlyMap<string, BlockerActorBakeInput>,
): Affine {
  // A blocker never collapses below the bake's minimum extent on any axis.
  const scale = (actor.transform.scale ?? [1, 1, 1]).map((value) =>
    Math.sign(value || 1) * Math.max(Math.abs(value), 0.05));
  let world = trsAffine(actor.transform.position, actor.transform.rotation, scale);
  const visited = new Set<string>(actor.id ? [actor.id] : []);
  for (let parentId = actor.parentId; parentId && !visited.has(parentId);) {
    visited.add(parentId);
    const parent = actorsById.get(parentId);
    if (!parent) break;
    world = multiplyAffine(trsAffine(parent.transform.position, parent.transform.rotation, parent.transform.scale), world);
    parentId = parent.parentId;
  }
  return world;
}

/**
 * The unit volume the editor draws for a blocker (a box or a diameter-1
 * cylinder, height 1 along local Y) placed by its world transform. In 2D the
 * actor's local XY plane is the walk plane and the volume becomes a prism
 * on Recast Y from 0 to 2.
 */
function blockerSolid(
  kind: NavObstacleKind,
  world: Affine,
  viewportMode: "2d" | "3d",
): { positions: number[]; indices: number[] } {
  const unit = solidBlockerMesh({ kind, pose: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } });
  const positions: number[] = [];
  for (let i = 0; i < unit.positions.length; i += 3) {
    const lx = unit.positions[i]!;
    const ly = unit.positions[i + 1]!;
    const lz = unit.positions[i + 2]!;
    if (viewportMode === "2d") {
      const planar = applyAffine(world, lx, lz, 0);
      const recast = worldToRecast(planar);
      positions.push(recast.x, 1 + ly * 2, recast.z);
    } else {
      const point = applyAffine(world, lx, ly, lz);
      positions.push(point.x, point.y, point.z);
    }
  }
  const determinant = viewportMode === "2d"
    ? world[0]! * world[5]! - world[1]! * world[4]!
    : world[0]! * (world[5]! * world[10]! - world[6]! * world[9]!) -
      world[1]! * (world[4]! * world[10]! - world[6]! * world[8]!) +
      world[2]! * (world[4]! * world[9]! - world[5]! * world[8]!);
  // A mirrored transform flips the winding; keep the solid's faces outward.
  const indices = [...unit.indices];
  if (determinant < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
    }
  }
  return { positions, indices };
}

/** Whether a Recast-space solid meets the bake bounds; 2D compares world XY only. */
function solidIntersectsBakeBounds(
  positions: readonly number[],
  viewportMode: "2d" | "3d",
  bounds: NavBakeBounds,
): boolean {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    const point = viewportMode === "2d"
      ? recastToWorld({ x: positions[i]!, y: positions[i + 1]!, z: positions[i + 2]! })
      : { x: positions[i]!, y: positions[i + 1]!, z: positions[i + 2]! };
    min.x = Math.min(min.x, point.x); max.x = Math.max(max.x, point.x);
    min.y = Math.min(min.y, point.y); max.y = Math.max(max.y, point.y);
    min.z = Math.min(min.z, point.z); max.z = Math.max(max.z, point.z);
  }
  const overlaps = (axis: "x" | "y" | "z") =>
    min[axis] <= Math.max(bounds.min[axis], bounds.max[axis]) &&
    max[axis] >= Math.min(bounds.min[axis], bounds.max[axis]);
  return overlaps("x") && overlaps("y") && (viewportMode === "2d" || overlaps("z"));
}

/** Static unwalkable blockers become bake solids. Dynamic / cost are skipped. */
export function staticBlockerBakeParts(
  actors: readonly BlockerActorBakeInput[],
  viewportMode: "2d" | "3d",
  bakeBounds?: NavBakeBounds,
): NavBakeMeshPart[] {
  const parts: NavBakeMeshPart[] = [];
  let actorsById: Map<string, BlockerActorBakeInput> | null = null;
  for (const actor of actors) {
    for (const component of actor.components) {
      if (component.classId !== "NavMeshBlockerComponent") continue;
      if (asBoolean(component.properties.dynamic, false)) continue;
      if (component.properties.area === "cost") continue;
      const kind: NavObstacleKind =
        component.properties.kind === "cylinder" ? "cylinder" : "box";
      actorsById ??= new Map(actors.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : [])));
      const solid = blockerSolid(kind, blockerWorldAffine(actor, actorsById), viewportMode);
      if (bakeBounds && !solidIntersectsBakeBounds(solid.positions, viewportMode, bakeBounds)) continue;
      parts.push(solid);
    }
  }
  return parts;
}

/**
 * 2D floor bounds: actor origins plus the Recast XZ walls and solids baked on
 * it (collider and tilemap geometry), padded so walls never sit off the floor.
 */
export function xyBoundsFromActors(
  actors: readonly BlockerActorBakeInput[],
  pad = 8,
  geometry: readonly NavBakeMeshPart[] = [],
): XyBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const actor of actors) {
    include(actor.transform.position[0], actor.transform.position[1]);
  }
  for (const part of geometry) {
    for (let i = 0; i + 2 < part.positions.length; i += 3) {
      const x = Number(part.positions[i]);
      const y = Number(part.positions[i + 1]);
      const z = Number(part.positions[i + 2]);
      const recast = part.transform ? part.transform(x, y, z) : { x, y, z };
      const point = recastToWorld(recast);
      include(point.x, point.y);
    }
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
  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  // Solids stand on the walk plane (Recast Y = 0), like the walls.
  const disc = (x: number, y: number, radius: number) => {
    const recast = worldToRecast({ x, y, z: 0 });
    return solidBlockerMesh({
      kind: "cylinder",
      pose: { x: recast.x, y: height / 2, z: recast.z },
      size: { x: radius * 2, y: height, z: radius * 2 },
    });
  };
  if (kind === "circle") {
    return [disc(position.x, position.y, positive(shape.radius, 0.5))];
  }
  if (kind === "capsule2d") {
    // A vertical stadium: a box between the two end discs.
    const radius = positive(shape.radius, 0.25);
    const halfHeight = positive(shape.halfHeight, 0.5);
    const recast = worldToRecast({ x: position.x, y: position.y, z: 0 });
    return [
      solidBlockerMesh({
        kind: "box",
        pose: { x: recast.x, y: height / 2, z: recast.z },
        size: { x: radius * 2, y: height, z: halfHeight * 2 },
      }),
      disc(position.x, position.y - halfHeight, radius),
      disc(position.x, position.y + halfHeight, radius),
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
