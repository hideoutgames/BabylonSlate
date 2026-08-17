import type { Transform } from "@babylonslate/core";
import type { Actor } from "@babylonslate/object-model";

export type ActorTransformMap = ReadonlyMap<string, Transform>;

/** Compose every actor's local hierarchy into world space once per tick. */
export function actorWorldTransforms(
  actors: readonly Actor[],
): Map<string, Transform> {
  const byGuid = new Map(actors.map((actor) => [actor.guid, actor]));
  const resolved = new Map<string, Transform>();
  const resolving = new Set<string>();

  const resolve = (actor: Actor): Transform => {
    const cached = resolved.get(actor.guid);
    if (cached) return cached;
    const local = copyTransform(actor.transform);
    if (resolving.has(actor.guid)) return local;

    resolving.add(actor.guid);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? byGuid.get(parentId) : undefined;
    const world =
      parent && !resolving.has(parent.guid)
        ? composeParentChildTransform(resolve(parent), local)
        : local;
    resolving.delete(actor.guid);
    resolved.set(actor.guid, world);
    return world;
  };

  for (const actor of actors) resolve(actor);
  return resolved;
}

export function actorParentGuid(actor: Actor): string | null {
  const parentId = actor.getVariable("parentId");
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

export function copyTransform(value: Transform): Transform {
  return {
    position: { ...value.position },
    rotation: { ...value.rotation },
    scale: { ...value.scale },
  };
}

export function composeParentChildTransform(
  parent: Transform,
  local: Transform,
): Transform {
  const scaled = {
    x: local.position.x * parent.scale.x,
    y: local.position.y * parent.scale.y,
    z: local.position.z * parent.scale.z,
  };
  const rotated = rotateVector(parent.rotation, scaled);
  return {
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    rotation: multiplyQuaternion(parent.rotation, local.rotation),
    scale: {
      x: parent.scale.x * local.scale.x,
      y: parent.scale.y * local.scale.y,
      z: parent.scale.z * local.scale.z,
    },
  };
}

export function multiplyQuaternion(
  a: Transform["rotation"],
  b: Transform["rotation"],
): Transform["rotation"] {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function inverseQuaternion(
  value: Transform["rotation"],
): Transform["rotation"] {
  const lengthSquared =
    value.x * value.x +
    value.y * value.y +
    value.z * value.z +
    value.w * value.w;
  if (lengthSquared === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: -value.x / lengthSquared,
    y: -value.y / lengthSquared,
    z: -value.z / lengthSquared,
    w: value.w / lengthSquared,
  };
}

export function rotateVector(
  quaternion: Transform["rotation"],
  value: Transform["position"],
): Transform["position"] {
  const { x, y, z, w } = quaternion;
  const ix = w * value.x + y * value.z - z * value.y;
  const iy = w * value.y + z * value.x - x * value.z;
  const iz = w * value.z + x * value.y - y * value.x;
  const iw = -x * value.x - y * value.y - z * value.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}
