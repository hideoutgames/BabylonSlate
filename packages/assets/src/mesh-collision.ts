import { packCollisionTriangleMesh, type CollisionTriangleMesh } from "@babylonslate/core";
import type { ModelPayload } from "./model-payload";
import { extractGltfCollisionMesh } from "./glb-geometry";
import {
  createDefaultSimpleCollider,
  simpleColliderToPhysicsShape,
  IDENTITY_SIMPLE_COLLIDER_TRANSFORM,
  type ModelSimpleCollider,
  type SimpleColliderPhysicsShape,
} from "./simple-collision";

export type MeshCollisionMode = "simple" | "complex" | "none";

export function parseMeshCollisionMode(value: unknown): MeshCollisionMode {
  if (value === "complex" || value === "none" || value === "simple") return value;
  return "simple";
}

export function parseMeshCollisionLayer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0
    ? value
    : 1;
}

export function parseMeshCollisionMask(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0xffffffff;
}

/** Built-in simple colliders matching `createPrimitiveMesh` sizes. */
export function simpleCollidersForMeshKind(
  meshKind: string | null | undefined,
): ModelSimpleCollider[] {
  switch (meshKind) {
    case "sphere":
      return [{ ...createDefaultSimpleCollider("sphere", { id: "primitive", name: "Sphere" }), radius: 0.75 }];
    case "cylinder":
      return [
        {
          ...createDefaultSimpleCollider("cylinder", { id: "primitive", name: "Cylinder" }),
          radius: 0.5,
          height: 1.5,
        },
      ];
    case "plane":
    case "quad":
      return [
        {
          ...createDefaultSimpleCollider("box", { id: "primitive", name: "Plane" }),
          halfExtents: { x: 0.75, y: 0.75, z: 0.01 },
        },
      ];
    case "ground":
      return [
        {
          ...createDefaultSimpleCollider("box", { id: "primitive", name: "Ground" }),
          halfExtents: { x: 5, y: 0.01, z: 5 },
        },
      ];
    case "box":
    default:
      return [
        {
          ...createDefaultSimpleCollider("box", { id: "primitive", name: "Box" }),
          halfExtents: { x: 0.75, y: 0.75, z: 0.75 },
        },
      ];
  }
}

function boxMesh(hx: number, hy: number, hz: number): {
  vertices: Array<{ x: number; y: number; z: number }>;
  indices: number[];
} {
  const vertices = [
    { x: -hx, y: -hy, z: -hz },
    { x: hx, y: -hy, z: -hz },
    { x: hx, y: hy, z: -hz },
    { x: -hx, y: hy, z: -hz },
    { x: -hx, y: -hy, z: hz },
    { x: hx, y: -hy, z: hz },
    { x: hx, y: hy, z: hz },
    { x: -hx, y: hy, z: hz },
  ];
  const indices = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0,
    3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ];
  return { vertices, indices };
}

/** Rest-pose triangle soup for Use Complex Collision on engine primitives. */
export function complexCollisionMeshForMeshKind(
  meshKind: string | null | undefined,
): CollisionTriangleMesh {
  const mesh = (() => {
    switch (meshKind) {
      case "sphere":
        return latLongSphere(0.75, 12, 8);
      case "cylinder":
        return latLongCylinder(0.5, 1.5, 12);
      case "plane":
      case "quad":
        return boxMesh(0.75, 0.75, 0.01);
      case "ground":
        return boxMesh(5, 0.01, 5);
      case "box":
      default:
        return boxMesh(0.75, 0.75, 0.75);
    }
  })();
  return packCollisionTriangleMesh(mesh.vertices, mesh.indices);
}

function latLongSphere(
  radius: number,
  segments: number,
  rings: number,
): { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] } {
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      vertices.push({
        x: Math.sin(phi) * Math.cos(theta) * radius,
        y: Math.cos(phi) * radius,
        z: Math.sin(phi) * Math.sin(theta) * radius,
      });
    }
  }
  const indices: number[] = [];
  const cols = segments + 1;
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * cols + x;
      const b = a + cols;
      // Pole vertices coincide. Omit their zero-area faces so the generated
      // collision surface satisfies the native geometry validation contract.
      if (y > 0) indices.push(a, b, a + 1);
      if (y < rings - 1) indices.push(a + 1, b, b + 1);
    }
  }
  return { vertices, indices };
}

function latLongCylinder(
  radius: number,
  height: number,
  segments: number,
): { vertices: Array<{ x: number; y: number; z: number }>; indices: number[] } {
  const hy = height / 2;
  const vertices: Array<{ x: number; y: number; z: number }> = [
    { x: 0, y: hy, z: 0 },
    { x: 0, y: -hy, z: 0 },
  ];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    vertices.push({ x, y: hy, z }, { x, y: -hy, z });
  }
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    const top = 2 + i * 2;
    const bottom = top + 1;
    const nextTop = 2 + next * 2;
    const nextBottom = nextTop + 1;
    indices.push(0, top, nextTop, 1, nextBottom, bottom, top, bottom, nextTop, nextTop, bottom, nextBottom);
  }
  return { vertices, indices };
}

export function resolveMeshSimpleColliders(
  properties: Record<string, unknown>,
  modelPayload?: ModelPayload | null,
): ModelSimpleCollider[] {
  const mode = parseMeshCollisionMode(properties.collisionMode);
  if (mode !== "simple") return [];
  const assetGuid =
    typeof properties.assetGuid === "string" ? properties.assetGuid.trim() : "";
  if (assetGuid) return modelPayload?.simpleColliders ?? [];
  const meshKind =
    typeof properties.meshKind === "string" ? properties.meshKind : "box";
  return simpleCollidersForMeshKind(meshKind);
}

export type ResolvedMeshCollision = {
  shapeId: string;
  shape: SimpleColliderPhysicsShape;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

/** Stable key so editor meshes rebuild when Mesh collision or Model hulls change. */
export function meshCollisionFingerprint(
  properties: Record<string, unknown>,
  modelPayload?: ModelPayload | null,
): string {
  const mode = parseMeshCollisionMode(properties.collisionMode);
  if (mode === "none") return "none";
  const assetGuid =
    typeof properties.assetGuid === "string" ? properties.assetGuid.trim() : "";
  if (mode === "complex") {
    return `complex:${assetGuid || (typeof properties.meshKind === "string" ? properties.meshKind : "box")}`;
  }
  if (assetGuid) {
    return `simple:${assetGuid}:${JSON.stringify(modelPayload?.simpleColliders ?? [])}`;
  }
  return `simple:${typeof properties.meshKind === "string" ? properties.meshKind : "box"}`;
}

/** Cook one Model's rest-pose triangles; `null` when the source has fewer than three vertices. */
export function cookComplexCollisionMesh(
  source: Uint8Array,
  modelPayload?: ModelPayload | null,
): CollisionTriangleMesh | null {
  const mesh = extractGltfCollisionMesh(source, modelPayload?.importScale ?? 1);
  return mesh && mesh.positions.length >= 9 ? mesh : null;
}

/**
 * Cook the Models in `only` (every Model when omitted). Callers pass the
 * `complexCollisionModelGuids` of their document closure so Models that never
 * use Complex Collision are not parsed.
 */
export function cookComplexCollisionMeshes(
  modelBytes: ReadonlyMap<string, Uint8Array> | undefined,
  modelPayloads?: ReadonlyMap<string, ModelPayload> | undefined,
  only?: ReadonlySet<string>,
): Map<string, CollisionTriangleMesh> {
  const out = new Map<string, CollisionTriangleMesh>();
  if (!modelBytes) return out;
  for (const [guid, bytes] of modelBytes) {
    if (only && !only.has(guid)) continue;
    const mesh = cookComplexCollisionMesh(bytes, modelPayloads?.get(guid));
    if (mesh) out.set(guid, mesh);
  }
  return out;
}

/**
 * Model GUIDs that authored content can simulate with Use Complex Collision:
 * `MeshComponent` rows whose `collisionMode` is `complex` and that name a Model
 * `assetGuid`, in Scene / SceneLayer `actors[].components` and in Class
 * prefab or compiled-script `components`. Runtime-only changes (a script
 * switching Collision Mode or the Model) are served on demand instead.
 */
export function complexCollisionModelGuids(documents: Iterable<unknown>): Set<string> {
  const guids = new Set<string>();
  const visit = (components: unknown) => {
    if (!Array.isArray(components)) return;
    for (const component of components) {
      if (!component || typeof component !== "object") continue;
      const { classId, properties } = component as { classId?: unknown; properties?: unknown };
      // Scene normalization treats a missing classId as a MeshComponent.
      if ((classId !== undefined && classId !== "MeshComponent") || !properties || typeof properties !== "object") continue;
      const values = properties as Record<string, unknown>;
      if (parseMeshCollisionMode(values.collisionMode) !== "complex") continue;
      const guid = typeof values.assetGuid === "string" ? values.assetGuid.trim() : "";
      if (guid) guids.add(guid);
    }
  };
  for (const document of documents) {
    if (!document || typeof document !== "object") continue;
    const record = document as { components?: unknown; actors?: unknown };
    visit(record.components);
    if (Array.isArray(record.actors))
      for (const actor of record.actors)
        if (actor && typeof actor === "object") visit((actor as { components?: unknown }).components);
  }
  return guids;
}

export function resolveMeshCollisions(
  properties: Record<string, unknown>,
  options?: {
    modelPayload?: ModelPayload | null;
    complexMesh?: CollisionTriangleMesh | null;
  },
): ResolvedMeshCollision[] {
  const mode = parseMeshCollisionMode(properties.collisionMode);
  if (mode === "none") return [];
  if (mode === "simple") {
    return resolveMeshSimpleColliders(properties, options?.modelPayload).map(
      (collider) => ({
        shapeId: collider.id,
        shape: simpleColliderToPhysicsShape(collider),
        position: collider.position,
        rotation: collider.rotation,
        scale: collider.scale,
      }),
    );
  }
  const identity = IDENTITY_SIMPLE_COLLIDER_TRANSFORM;
  const assetGuid =
    typeof properties.assetGuid === "string" ? properties.assetGuid.trim() : "";
  if (assetGuid) {
    const mesh = options?.complexMesh;
    if (!mesh || mesh.positions.length < 9) return [];
    return [
      {
        shapeId: "complex",
        shape: { kind: "mesh", positions: mesh.positions, indices: mesh.indices },
        ...identity,
      },
    ];
  }
  const tessellated = complexCollisionMeshForMeshKind(
    typeof properties.meshKind === "string" ? properties.meshKind : "box",
  );
  return [
    {
      shapeId: "complex",
      shape: { kind: "mesh", positions: tessellated.positions, indices: tessellated.indices },
      ...identity,
    },
  ];
}

