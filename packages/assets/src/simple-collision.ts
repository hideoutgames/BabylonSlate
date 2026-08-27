import { newAssetGuid } from "./guid";
import { convexHull3d, type HullVec3 } from "./convex-hull";
import { extractGltfPositions } from "./glb-geometry";

export type ModelSimpleColliderKind =
  | "box"
  | "sphere"
  | "capsule"
  | "cylinder"
  | "cone"
  | "generated";

export type ModelSimpleCollider = {
  id: string;
  name: string;
  kind: ModelSimpleColliderKind;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  halfExtents?: { x: number; y: number; z: number };
  radius?: number;
  halfHeight?: number;
  height?: number;
  points?: HullVec3[];
};

export const IDENTITY_SIMPLE_COLLIDER_TRANSFORM = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

export const SIMPLE_COLLIDER_KIND_LABELS: Record<ModelSimpleColliderKind, string> =
  {
    box: "Box",
    sphere: "Sphere",
    capsule: "Capsule",
    cylinder: "Cylinder",
    cone: "Cone",
    generated: "Generated Collision",
  };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tuple3(
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    numberOr(value[0], fallback[0]),
    numberOr(value[1], fallback[1]),
    numberOr(value[2], fallback[2]),
  ];
}

function quat(
  value: unknown,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) {
    return [...IDENTITY_SIMPLE_COLLIDER_TRANSFORM.rotation];
  }
  return [
    numberOr(value[0], 0),
    numberOr(value[1], 0),
    numberOr(value[2], 0),
    typeof value[3] === "number" && Number.isFinite(value[3]) ? value[3] : 1,
  ];
}

function parsePoints(value: unknown): HullVec3[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const point = asRecord(entry);
    return {
      x: numberOr(point.x, 0),
      y: numberOr(point.y, 0),
      z: numberOr(point.z, 0),
    };
  });
}

function parseKind(value: unknown): ModelSimpleColliderKind {
  if (
    value === "box" ||
    value === "sphere" ||
    value === "capsule" ||
    value === "cylinder" ||
    value === "cone" ||
    value === "generated"
  ) {
    return value;
  }
  return "box";
}

export function boundsBoxFromPoints(points: readonly HullVec3[]): {
  x: number;
  y: number;
  z: number;
} {
  if (points.length === 0) return { x: 0.5, y: 0.5, z: 0.5 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);
  }
  return {
    x: Math.max(0.01, (maxX - minX) / 2),
    y: Math.max(0.01, (maxY - minY) / 2),
    z: Math.max(0.01, (maxZ - minZ) / 2),
  };
}

export function createDefaultSimpleCollider(
  kind: ModelSimpleColliderKind,
  options?: { id?: string; name?: string },
): ModelSimpleCollider {
  const id = options?.id ?? newAssetGuid();
  const name = options?.name ?? SIMPLE_COLLIDER_KIND_LABELS[kind];
  const base = {
    id,
    name,
    kind,
    ...IDENTITY_SIMPLE_COLLIDER_TRANSFORM,
  };
  switch (kind) {
    case "sphere":
      return { ...base, kind, radius: 0.5 };
    case "capsule":
      return { ...base, kind, radius: 0.25, halfHeight: 0.5 };
    case "cylinder":
      return { ...base, kind, radius: 0.5, height: 1 };
    case "cone":
      return { ...base, kind, radius: 0.5, height: 1 };
    case "generated":
      return { ...base, kind, points: [] };
    case "box":
    default:
      return { ...base, kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
  }
}

export function normalizeModelSimpleCollider(value: unknown): ModelSimpleCollider {
  const record = asRecord(value);
  const kind = parseKind(record.kind);
  const id =
    typeof record.id === "string" && record.id.trim().length > 0
      ? record.id.trim()
      : newAssetGuid();
  const name =
    typeof record.name === "string" && record.name.trim().length > 0
      ? record.name.trim()
      : SIMPLE_COLLIDER_KIND_LABELS[kind];
  const base = {
    id,
    name,
    position: tuple3(record.position, IDENTITY_SIMPLE_COLLIDER_TRANSFORM.position),
    rotation: quat(record.rotation),
    scale: tuple3(record.scale, IDENTITY_SIMPLE_COLLIDER_TRANSFORM.scale),
  };
  switch (kind) {
    case "sphere":
      return { ...base, kind, radius: Math.max(0.001, numberOr(record.radius, 0.5)) };
    case "capsule":
      return {
        ...base,
        kind,
        radius: Math.max(0.001, numberOr(record.radius, 0.25)),
        halfHeight: Math.max(0.001, numberOr(record.halfHeight, 0.5)),
      };
    case "cylinder":
    case "cone":
      return {
        ...base,
        kind,
        radius: Math.max(0.001, numberOr(record.radius, 0.5)),
        height: Math.max(0.001, numberOr(record.height, 1)),
      };
    case "generated":
      return { ...base, kind, points: parsePoints(record.points) };
    case "box":
    default: {
      const extents = asRecord(record.halfExtents);
      return {
        ...base,
        kind: "box",
        halfExtents: {
          x: Math.max(0.001, numberOr(extents.x, 0.5)),
          y: Math.max(0.001, numberOr(extents.y, 0.5)),
          z: Math.max(0.001, numberOr(extents.z, 0.5)),
        },
      };
    }
  }
}

export function normalizeModelSimpleColliders(value: unknown): ModelSimpleCollider[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeModelSimpleCollider(entry));
}

export function generateSimpleCollisionFromPoints(
  points: readonly HullVec3[],
  options?: { id?: string; name?: string },
): ModelSimpleCollider {
  const hull = convexHull3d(points);
  if (hull.length >= 4) {
    return {
      ...createDefaultSimpleCollider("generated", options),
      points: hull,
    };
  }
  return {
    ...createDefaultSimpleCollider("box", {
      id: options?.id,
      name: options?.name ?? SIMPLE_COLLIDER_KIND_LABELS.generated,
    }),
    halfExtents: boundsBoxFromPoints(points),
  };
}

export function cookGeneratedCollisionFromGltf(
  bytes: Uint8Array,
  options?: { importScale?: number; id?: string; name?: string },
): ModelSimpleCollider {
  const points = extractGltfPositions(bytes, options?.importScale ?? 1);
  return generateSimpleCollisionFromPoints(points, {
    id: options?.id,
    name: options?.name ?? SIMPLE_COLLIDER_KIND_LABELS.generated,
  });
}

export function coneConvexPoints(
  radius: number,
  height: number,
  segments = 12,
): HullVec3[] {
  const hy = height / 2;
  const points: HullVec3[] = [{ x: 0, y: hy, z: 0 }];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push({
      x: Math.cos(theta) * radius,
      y: -hy,
      z: Math.sin(theta) * radius,
    });
  }
  return points;
}

export type SimpleColliderPhysicsShape =
  | { kind: "box"; halfExtents: { x: number; y: number; z: number } }
  | { kind: "sphere"; radius: number }
  | { kind: "capsule"; radius: number; halfHeight: number }
  | { kind: "cylinder"; radius: number; height: number }
  | { kind: "convex"; points: HullVec3[] }
  | { kind: "mesh"; vertices: HullVec3[]; indices: number[] };

export function simpleColliderToPhysicsShape(
  collider: ModelSimpleCollider,
): SimpleColliderPhysicsShape {
  switch (collider.kind) {
    case "sphere":
      return { kind: "sphere", radius: collider.radius ?? 0.5 };
    case "capsule":
      return {
        kind: "capsule",
        radius: collider.radius ?? 0.25,
        halfHeight: collider.halfHeight ?? 0.5,
      };
    case "cylinder":
      return {
        kind: "cylinder",
        radius: collider.radius ?? 0.5,
        height: collider.height ?? 1,
      };
    case "cone":
      return {
        kind: "convex",
        points: coneConvexPoints(collider.radius ?? 0.5, collider.height ?? 1),
      };
    case "generated":
      return { kind: "convex", points: collider.points ?? [] };
    case "box":
    default:
      return {
        kind: "box",
        halfExtents: collider.halfExtents ?? { x: 0.5, y: 0.5, z: 0.5 },
      };
  }
}

export function cylinderConvexPoints(
  radius: number,
  height: number,
  segments = 12,
): HullVec3[] {
  const hy = height / 2;
  const points: HullVec3[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    points.push({ x, y: hy, z }, { x, y: -hy, z });
  }
  return points;
}
