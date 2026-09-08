/** Authored component IDs can repeat between actors in older scene documents. */
export function componentColliderPhysicsId(
  actorGuid: string,
  componentGuid: string,
  shapeId?: string,
): string {
  return shapeId === undefined
    ? `collider:${JSON.stringify([actorGuid, componentGuid])}`
    : `mesh-collider:${JSON.stringify([actorGuid, componentGuid, shapeId])}`;
}

/** Restore authored IDs when routing contacts to component-bound script events. */
export function componentIdFromColliderPhysicsId(
  colliderId: string | undefined,
): string | undefined {
  if (!colliderId) return undefined;
  const prefix = colliderId.startsWith("collider:")
    ? "collider:"
    : colliderId.startsWith("mesh-collider:")
      ? "mesh-collider:"
      : null;
  if (!prefix) return colliderId;
  const identity = colliderId.slice(prefix.length);
  if (identity.startsWith("[")) {
    try {
      const parts: unknown = JSON.parse(identity);
      if (
        Array.isArray(parts) &&
        parts.length >= 2 &&
        typeof parts[1] === "string"
      ) {
        return parts[1];
      }
    } catch {
      // Accept legacy component IDs that happen to start with a bracket.
    }
  }
  return prefix === "collider:" ? identity : colliderId;
}
