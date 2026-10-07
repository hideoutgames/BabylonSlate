/** Remap only typed scene object references; asset GUIDs and prefab sources stay unchanged. */
export function remapScenePropertyReferences(
  value: unknown,
  actorIds: ReadonlyMap<string, string>,
  componentIds: ReadonlyMap<string, ReadonlyMap<string, string>>,
): unknown {
  const remap = (entry: unknown, depth: number): unknown => {
    if (depth > 128) throw new Error("Scene property nesting exceeds the supported limit.");
    if (!entry || typeof entry !== "object") return entry;
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) return entry;
    const row = entry as Record<string, unknown>;
    if (row.$sceneValue === "reference" && typeof row.actorId === "string") {
      const actorId = actorIds.get(row.actorId);
      if (!actorId) return entry;
      if (row.componentId === undefined) return { ...row, actorId };
      const componentId = typeof row.componentId === "string" ? componentIds.get(row.actorId)?.get(row.componentId) : undefined;
      if (!componentId) throw new Error(`Duplicated scene reference has no component: ${String(row.componentId)}`);
      return { ...row, actorId, componentId };
    }
    let changed: unknown[] | Record<string, unknown> | undefined;
    for (const key of Object.keys(entry)) {
      const before = row[key], after = remap(before, depth + 1);
      if (before !== after) {
        changed ??= Array.isArray(entry) ? [...entry] : { ...row };
        Object.defineProperty(changed, key, { value: after, enumerable: true, configurable: true, writable: true });
      }
    }
    return changed ?? entry;
  };
  return remap(value, 0);
}
