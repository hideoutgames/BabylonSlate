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
  "gameInstanceClass", "editorUtilityObjects", "logicClass",
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
  const walk = (current: unknown, key?: string, owner?: Record<string, unknown>, pinDefaults: ReadonlySet<string> = new Set()): unknown => {
    if (typeof current === "string") {
      const byGuid = guids.get(current);
      const field = key?.replace(/^default:/, "");
      const typedDefault = key === "defaultValue" && owner?.typeId === "class";
      const match = byGuid ?? (field && (CLASS_FIELDS.has(field) || typedDefault || pinDefaults.has(key!)) ? names.get(current) : undefined);
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
        const result = walk(entry, key, owner, pinDefaults);
        changed ||= result !== entry;
        if (typeof entry !== "string" || result !== null) next.push(result);
      }
      return changed ? next : current;
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const localDefaults = new Set(pinDefaults);
      if (Array.isArray(record.pins)) for (const pin of record.pins) {
        if (pin && typeof pin === "object" && (pin.type?.kind === "classRef" || pin.typeId === "class")) {
          if (typeof pin.id === "string") localDefaults.add(`default:${pin.id}`);
          if (typeof pin.name === "string") localDefaults.add(`default:${pin.name}`);
        }
      }
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [childKey, entry] of Object.entries(record)) {
        let result: unknown;
        if (childKey === "defaultValue" && record.container === "map" && Array.isArray(entry)) {
          const entries = entry.map((row: unknown) => {
            if (!row || typeof row !== "object") return row;
            const pair = row as Record<string, unknown>;
            const mapKey = walk(pair.key, record.keyTypeId === "class" ? "class" : "key");
            const mapValue = walk(pair.value, record.typeId === "class" ? "class" : "value");
            return mapKey === pair.key && mapValue === pair.value ? row : { ...pair, key: mapKey, value: mapValue };
          });
          result = entries.some((row, index) => row !== entry[index]) ? entries : entry;
        } else result = walk(entry, childKey, record, localDefaults);
        changed ||= result !== entry;
        next[childKey] = result;
      }
      return changed ? next : current;
    }
    return current;
  };
  return { value: walk(value) as T, references: [...references].sort() };
}
