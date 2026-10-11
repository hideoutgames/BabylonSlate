/** Component IDs can repeat between actors, so the actor guid qualifies them. */
export function componentColliderPhysicsId(
  actorGuid: string,
  componentGuid: string,
  shapeId?: string,
): string {
  return shapeId === undefined
    ? `collider:${JSON.stringify([actorGuid, componentGuid])}`
    : `mesh-collider:${JSON.stringify([actorGuid, componentGuid, shapeId])}`;
}

/**
 * A hosted child shape on a simulated ancestor's compound. The host guid keeps
 * it distinct from the child's own-body collider and from another host's copy,
 * so moving between bodies never reuses a live ID, while component-bound
 * script events still decode the child's component ID. Component colliders
 * take the host as a last array entry; tilemap chain IDs take a suffix.
 */
export function hostedColliderPhysicsId(
  colliderId: string,
  hostGuid: string,
): string {
  const host = JSON.stringify(`@${hostGuid}`);
  return (colliderId.startsWith("collider:[") ||
    colliderId.startsWith("mesh-collider:[")) &&
    colliderId.endsWith("]")
    ? `${colliderId.slice(0, -1)},${host}]`
    : `${colliderId}@${host}`;
}

/**
 * Restore authored IDs when routing contacts to component-bound script events.
 * Colliders that no component owns (tilemap chains) keep their own ID.
 */
export function componentIdFromColliderPhysicsId(
  colliderId: string | undefined,
): string | undefined {
  if (!colliderId) return undefined;
  const prefix = colliderId.startsWith("collider:[")
    ? "collider:"
    : colliderId.startsWith("mesh-collider:[")
      ? "mesh-collider:"
      : null;
  if (!prefix) return colliderId;
  const parts = JSON.parse(colliderId.slice(prefix.length)) as unknown[];
  return parts[1] as string;
}
