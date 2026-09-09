export interface ClassAssetReference {
  guid: string;
  classId: string;
}

export interface ClassAssetReplacement extends ClassAssetReference {
  replacement: ClassAssetReference | null;
}

const CLASS_FIELDS = new Set([
  "class", "classId", "classRef", "actorClass", "componentClass",
  "typeClassId", "keyTypeClassId", "valueTypeClassId", "parentClass",
  "gameInstanceClass", "editorUtilityObjects",
]);

/** Finds actual Class identifiers without matching display names or source text. */
export function findClassAssetReferences(
  value: unknown,
  classes: readonly ClassAssetReference[],
): string[] {
  return transform(value, classes, false).references;
}

/** Rewrites references once, preserving unrelated values and serialized instances. */
export function replaceClassAssetReferences<T>(
  value: T,
  replacements: readonly ClassAssetReplacement[],
): { value: T; changed: boolean } {
  const result = transform(value, replacements, true);
  return { value: result.value, changed: result.value !== value };
}

function transform<T>(
  value: T,
  classes: readonly (ClassAssetReference & { replacement?: ClassAssetReference | null })[],
  replace: boolean,
): { value: T; references: string[] } {
  const guids = new Map(classes.map((entry) => [entry.guid, entry]));
  const names = new Map(classes.map((entry) => [entry.classId, entry]));
  const references = new Set<string>();
  const walk = (current: unknown, key?: string, owner?: Record<string, unknown>): unknown => {
    if (typeof current === "string") {
      const byGuid = guids.get(current);
      const field = key?.replace(/^default:/, "");
      const typedDefault = key === "defaultValue" && owner?.typeId === "class";
      const match = byGuid ?? (field && (CLASS_FIELDS.has(field) || typedDefault) ? names.get(current) : undefined);
      if (!match) return current;
      references.add(match.guid);
      if (!replace) return current;
      if (match.replacement) return byGuid ? match.replacement.guid : match.replacement.classId;
      if (key === "parentClass") return "BObject";
      if (key === "classId" && owner) {
        if (Array.isArray(owner.components)) return "Actor";
        if (owner.properties && typeof owner.properties === "object") return "ActorComponent";
        if (owner.kind === "actorRef") return "Actor";
        if (owner.kind === "componentRef") return "ActorComponent";
        if (owner.kind === "classRef" || owner.kind === "objectRef") return "BObject";
      }
      return null;
    }
    if (Array.isArray(current)) {
      let changed = false;
      const next: unknown[] = [];
      for (const entry of current) {
        const result = walk(entry, key);
        changed ||= result !== entry;
        if (typeof entry !== "string" || result !== null) next.push(result);
      }
      return changed ? next : current;
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [childKey, entry] of Object.entries(record)) {
        const result = walk(entry, childKey, record);
        changed ||= result !== entry;
        next[childKey] = result;
      }
      return changed ? next : current;
    }
    return current;
  };
  return { value: walk(value) as T, references: [...references].sort() };
}
