import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import {
  identitySerializedTransform,
  springArmChildOffset,
  type SerializedActor,
  type SerializedComponent,
  type SerializedTransform,
} from "@babylonslate/core";

export function authoredTransformMatrix(transform: SerializedTransform): Matrix {
  return Matrix.Compose(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation), Vector3.FromArray(transform.position));
}

/**
 * A component's transform relative to its actor origin: its parent components
 * compose in, and a Spring Arm parent adds its socket offset. Unparented
 * components return their own local transform unchanged.
 */
export function authoredComponentActorTransform(
  actor: Pick<SerializedActor, "components">,
  component: SerializedComponent,
): SerializedTransform {
  const local = component.transform ?? identitySerializedTransform();
  if (!component.parentId) return local;
  const byId = new Map(actor.components.map((entry) => [entry.id, entry]));
  const matrix = authoredTransformMatrix(local);
  const visited = new Set([component.id]);
  let parent = byId.get(component.parentId);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    const offset = springArmChildOffset(parent);
    if (offset) matrix.multiplyToRef(Matrix.Translation(offset[0], offset[1], offset[2]), matrix);
    matrix.multiplyToRef(authoredTransformMatrix(parent.transform ?? identitySerializedTransform()), matrix);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  const scale = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  if (!matrix.decompose(scale, rotation, position)) return local;
  return {
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
  };
}

/** Resolve serialized actor parents once per changed document, retaining shear. */
export function authoredActorMatrices(actors: readonly SerializedActor[]): (actor: SerializedActor) => Matrix {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const cache = new Map<string, Matrix>();
  const visiting = new Set<string>();
  const world = (actor: SerializedActor): Matrix => {
    const cached = cache.get(actor.id);
    if (cached) return cached;
    if (visiting.has(actor.id)) throw new Error("Cyclic actor attachment.");
    visiting.add(actor.id);
    try {
      const result = authoredTransformMatrix(actor.transform);
      if (actor.parentId) {
        const parent = byId.get(actor.parentId);
        if (!parent) throw new Error("Missing actor attachment.");
        result.multiplyToRef(world(parent), result);
      }
      cache.set(actor.id, result);
      return result;
    } finally { visiting.delete(actor.id); }
  };
  return world;
}

/**
 * Serializable world pose for detaching an actor from its authored parents: the world matrix's translation, rotation
 * and scale (a sheared matrix loses its shear), or for a degenerate one (a zero scale on the chain) its exact position
 * and the chain's composed rotation and scale.
 */
export function authoredActorWorldTransform(
  actors: readonly SerializedActor[],
  actor: SerializedActor,
): SerializedTransform {
  if (!actor.parentId) return structuredClone(actor.transform);
  const matrix = authoredActorMatrices(actors)(actor);
  const scale = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  // A zero scale on the chain leaves no rotation in the matrix: Babylon resets it, or derives one from the singular
  // axes, and flips Y on the zero determinant. The actor then keeps its exact world position, and its rotation and
  // scale compose along the chain.
  const decomposed = matrix.decompose(scale, rotation, position);
  if (!decomposed || Math.abs(matrix.determinant()) <= 1e-6 * Math.abs(scale.x * scale.y * scale.z)) {
    const byId = new Map(actors.map((entry) => [entry.id, entry]));
    rotation.copyFrom(Quaternion.FromArray(actor.transform.rotation));
    scale.copyFrom(Vector3.FromArray(actor.transform.scale));
    for (let parent = byId.get(actor.parentId); parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
      Quaternion.FromArray(parent.transform.rotation).multiplyToRef(rotation, rotation);
      scale.multiplyInPlace(Vector3.FromArray(parent.transform.scale));
    }
  }
  return {
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
  };
}
