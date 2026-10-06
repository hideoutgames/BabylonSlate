import type { SerializedComponent } from "@babylonslate/core";
import type { ColliderShape } from "@babylonslate/physics";

type HalfSize = { x: number; y: number; z: number };

/** Thin axis for flat primitives, so a box collider still has volume. */
const FLAT_HALF_THICKNESS = 0.01;

/**
 * Local half size of the built-in primitive meshes (`createPrimitiveMesh`).
 * Model, sprite and tilemap visuals have no synchronous size here.
 */
function primitiveHalfSize(meshKind: unknown): HalfSize | null {
  switch (meshKind) {
    case "sphere":
    case "box":
    case undefined:
    case null:
      return { x: 0.75, y: 0.75, z: 0.75 };
    case "cylinder":
      return { x: 0.5, y: 0.75, z: 0.5 };
    case "plane":
    case "quad":
      return { x: 0.75, y: 0.75, z: FLAT_HALF_THICKNESS };
    case "ground":
      return { x: 5, y: FLAT_HALF_THICKNESS, z: 5 };
    default:
      return null;
  }
}

function meshHalfSize(components: readonly SerializedComponent[]): HalfSize | null {
  const mesh = components.find(
    (component) =>
      component.classId === "MeshComponent" &&
      !(typeof component.properties.assetGuid === "string" && component.properties.assetGuid),
  );
  if (!mesh) return null;
  const half = primitiveHalfSize(mesh.properties.meshKind);
  if (!half) return null;
  const scale = mesh.transform?.scale ?? [1, 1, 1];
  return {
    x: half.x * Math.abs(scale[0]),
    y: half.y * Math.abs(scale[1]),
    z: half.z * Math.abs(scale[2]),
  };
}

/**
 * A collider of `kind` that wraps the actor's primitive mesh, or `null` when
 * the actor has no primitive to measure (callers keep the default size).
 */
export function fittedColliderShape(
  kind: string,
  components: readonly SerializedComponent[],
): ColliderShape | null {
  const half = meshHalfSize(components);
  if (!half) return null;
  switch (kind) {
    case "box":
      return { kind: "box", halfExtents: { ...half } };
    case "sphere":
      return { kind: "sphere", radius: Math.max(half.x, half.y, half.z) };
    case "capsule": {
      const radius = Math.max(half.x, half.z);
      return { kind: "capsule", radius, halfHeight: Math.max(0, half.y - radius) };
    }
    case "cylinder":
      return { kind: "cylinder", radius: Math.max(half.x, half.z), height: half.y * 2 };
    case "box2d":
      return { kind: "box2d", halfExtents: { x: half.x, y: half.y } };
    case "circle":
      return { kind: "circle", radius: Math.max(half.x, half.y) };
    case "capsule2d":
      return { kind: "capsule2d", radius: half.x, halfHeight: Math.max(0, half.y - half.x) };
    default:
      return null;
  }
}
