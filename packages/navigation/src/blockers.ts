import type { NavBakeMeshPart } from "./geometry";
import { worldToRecast } from "./remap";
import type { NavObstacleKind, NavPoint } from "./types";

export type NavBlockerArea = "unwalkable" | "cost";

export type SolidBlockerInput = {
  kind: NavObstacleKind;
  pose: NavPoint;
  size: NavPoint;
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

function boxMesh(pose: NavPoint, size: NavPoint): {
  positions: number[];
  indices: number[];
} {
  const hx = Math.max(size.x, 0.05) / 2;
  const hy = Math.max(size.y, 0.05) / 2;
  const hz = Math.max(size.z, 0.05) / 2;
  const verts: NavPoint[] = [
    { x: pose.x - hx, y: pose.y - hy, z: pose.z - hz },
    { x: pose.x + hx, y: pose.y - hy, z: pose.z - hz },
    { x: pose.x + hx, y: pose.y + hy, z: pose.z - hz },
    { x: pose.x - hx, y: pose.y + hy, z: pose.z - hz },
    { x: pose.x - hx, y: pose.y - hy, z: pose.z + hz },
    { x: pose.x + hx, y: pose.y - hy, z: pose.z + hz },
    { x: pose.x + hx, y: pose.y + hy, z: pose.z + hz },
    { x: pose.x - hx, y: pose.y + hy, z: pose.z + hz },
  ];
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

function cylinderMesh(pose: NavPoint, size: NavPoint): {
  positions: number[];
  indices: number[];
} {
  const radius = Math.max(size.x, 0.05);
  const height = Math.max(size.y, 0.05);
  const segments = 12;
  const y0 = pose.y;
  const y1 = pose.y + height;
  const positions: number[] = [];
  const indices: number[] = [];
  const ring: NavPoint[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push({
      x: pose.x + Math.cos(angle) * radius,
      y: 0,
      z: pose.z + Math.sin(angle) * radius,
    });
  }
  for (let i = 0; i < segments; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % segments]!;
    pushQuad(positions, indices, [
      { x: a.x, y: y0, z: a.z },
      { x: b.x, y: y0, z: b.z },
      { x: b.x, y: y1, z: b.z },
      { x: a.x, y: y1, z: a.z },
    ]);
  }
  const bottom: NavPoint[] = [];
  const top: NavPoint[] = [];
  for (const point of ring) {
    bottom.push({ x: point.x, y: y0, z: point.z });
    top.push({ x: point.x, y: y1, z: point.z });
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
  if (input.kind === "cylinder") return cylinderMesh(input.pose, input.size);
  return boxMesh(input.pose, input.size);
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
    scale?: [number, number, number];
  };
  components: Array<{ classId: string; properties: Record<string, unknown> }>;
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Static unwalkable blockers become bake solids. Dynamic / cost are skipped. */
export function staticBlockerBakeParts(
  actors: readonly BlockerActorBakeInput[],
  viewportMode: "2d" | "3d",
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
      const scale = actor.transform.scale ?? [1, 1, 1];
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
