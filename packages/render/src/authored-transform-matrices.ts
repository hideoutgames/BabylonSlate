import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { type SerializedActor, type SerializedTransform } from "@babylonslate/core";

export function authoredTransformMatrix(transform: SerializedTransform): Matrix {
  return Matrix.Compose(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation), Vector3.FromArray(transform.position));
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
