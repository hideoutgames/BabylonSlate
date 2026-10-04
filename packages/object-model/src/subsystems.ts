import {
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  isLockedEngineClassId,
} from "./ids";

export type SubsystemBaseClassId =
  | typeof GAME_SUBSYSTEM_CLASS_ID
  | typeof SCENE_SUBSYSTEM_CLASS_ID;

/**
 * Ancestry view shared by the runtime `ClassRegistry` and editor parent
 * lookups: the class id first, root last. The chain must reach the engine
 * `GameSubsystem` / `SceneSubsystem` id for a subsystem class.
 */
export type SubsystemClassHierarchy = {
  ancestry(classId: string): readonly string[];
};

/** Plain UTF-16 code-unit order (never locale-aware), the subsystem order. */
export function compareClassIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The subsystem base a class descends from (the bases resolve to themselves). */
export function subsystemBaseClassIdOf(
  hierarchy: SubsystemClassHierarchy,
  classId: string,
): SubsystemBaseClassId | null {
  const chain = hierarchy.ancestry(classId);
  if (chain.includes(GAME_SUBSYSTEM_CLASS_ID)) return GAME_SUBSYSTEM_CLASS_ID;
  if (chain.includes(SCENE_SUBSYSTEM_CLASS_ID)) return SCENE_SUBSYSTEM_CLASS_ID;
  return null;
}

/**
 * Subsystem classes instantiated for `base`: user (non-engine) classes that
 * descend from `base` and that no other user subsystem class extends (leaf-only
 * instancing). Sorted in class-id code-unit order, the lifecycle order.
 */
export function instantiableSubsystemClassIds(
  hierarchy: SubsystemClassHierarchy,
  classIds: Iterable<string>,
  base: SubsystemBaseClassId,
): string[] {
  const candidates = new Set<string>();
  for (const classId of classIds) {
    if (isLockedEngineClassId(classId)) continue;
    if (subsystemBaseClassIdOf(hierarchy, classId)) candidates.add(classId);
  }
  const extended = new Set<string>();
  for (const classId of candidates) {
    for (const ancestor of hierarchy.ancestry(classId).slice(1)) {
      extended.add(ancestor);
    }
  }
  return [...candidates]
    .filter(
      (classId) =>
        !extended.has(classId) && hierarchy.ancestry(classId).includes(base),
    )
    .sort(compareClassIds);
}

/**
 * Instantiable classes that satisfy `Get <requestedClassId>` (their ancestry
 * includes it), in class-id order. More than one entry is ambiguous; none
 * means the request is not a subsystem class or has no instantiable leaf.
 */
export function subsystemClassIdsForGet(
  hierarchy: SubsystemClassHierarchy,
  classIds: Iterable<string>,
  requestedClassId: string,
): string[] {
  const base = subsystemBaseClassIdOf(hierarchy, requestedClassId);
  if (!base) return [];
  return instantiableSubsystemClassIds(hierarchy, classIds, base).filter(
    (classId) => hierarchy.ancestry(classId).includes(requestedClassId),
  );
}

/** Fixed GameSubsystem guid; never drawn from the World guid factory. */
export function gameSubsystemGuid(classId: string): string {
  return `subsystem:${classId}`;
}

/** Fixed SceneSubsystem guid for the `creation`-th main Scene of the session. */
export function sceneSubsystemGuid(classId: string, creation: number): string {
  return `scene-subsystem:${classId}:${creation}`;
}
