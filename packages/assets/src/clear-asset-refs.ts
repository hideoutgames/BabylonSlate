import {
  userInterfaceAssetGuidFromClassId,
  type ProjectSettings,
} from "@babylonslate/core";

export type ClearDeletedAssetRefsResult<T> = {
  value: T;
  changed: boolean;
};

/** Engine default when a Class's parent asset is deleted. */
export const DELETED_CLASS_PARENT_FALLBACK = "BObject";

function isDeletedAssetRef(
  value: string,
  deletedGuids: ReadonlySet<string>,
): boolean {
  if (deletedGuids.has(value)) return true;
  const uiGuid = userInterfaceAssetGuidFromClassId(value);
  return uiGuid !== null && deletedGuids.has(uiGuid);
}

/**
 * Replace deleted asset guids with None (`null`) in a JSON-like payload.
 * String-array entries are dropped instead of becoming `null`.
 */
export function clearDeletedAssetRefs<T>(
  value: T,
  deletedGuids: ReadonlySet<string>,
  deletedClassNames: ReadonlySet<string> = new Set(),
): ClearDeletedAssetRefsResult<T> {
  if (deletedGuids.size === 0 && deletedClassNames.size === 0) {
    return { value, changed: false };
  }
  const walked = walk(value, deletedGuids, deletedClassNames);
  if (walked === value) {
    return { value, changed: false };
  }
  return { value: walked as T, changed: true };
}

export function fallbackParentClass(
  parentClass: string | null | undefined,
  deletedClassNames: ReadonlySet<string>,
): string | null {
  if (parentClass && deletedClassNames.has(parentClass)) {
    return DELETED_CLASS_PARENT_FALLBACK;
  }
  return parentClass ?? null;
}

export function clearDeletedRefsFromProjectSettings(
  settings: ProjectSettings,
  deletedGuids: ReadonlySet<string>,
  deletedClassNames: ReadonlySet<string> = new Set(),
): ClearDeletedAssetRefsResult<ProjectSettings> {
  const walked = clearDeletedAssetRefs(
    settings,
    deletedGuids,
    deletedClassNames,
  );
  let next = walked.value;
  let changed = walked.changed;
  if (next.editorUtilityObjects.some((id) => deletedClassNames.has(id))) {
    next = {
      ...next,
      editorUtilityObjects: next.editorUtilityObjects.filter(
        (id) => !deletedClassNames.has(id),
      ),
    };
    changed = true;
  }
  return { value: next, changed };
}

function walk(
  value: unknown,
  deletedGuids: ReadonlySet<string>,
  deletedClassNames: ReadonlySet<string>,
  key?: string,
): unknown {
  if (typeof value === "string") {
    if (isDeletedAssetRef(value, deletedGuids)) return null;
    if (key === "gameInstanceClass" && deletedClassNames.has(value)) return null;
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const entry of value) {
      if (typeof entry === "string" && isDeletedAssetRef(entry, deletedGuids)) {
        changed = true;
        continue;
      }
      const walked = walk(entry, deletedGuids, deletedClassNames, key);
      if (walked !== entry) changed = true;
      next.push(walked);
    }
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [childKey, entry] of Object.entries(record)) {
      const walked = walk(
        entry,
        deletedGuids,
        deletedClassNames,
        childKey,
      );
      if (walked !== entry) changed = true;
      next[childKey] = walked;
    }
    return changed ? next : value;
  }
  return value;
}
