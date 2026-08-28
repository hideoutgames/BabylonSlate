export type MapDefaultEntry = { key: unknown; value: unknown };

function isMapDefaultEntry(value: unknown): value is MapDefaultEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "key" in value &&
    "value" in value
  );
}

/** JSON `{ key, value }[]` (or a live Map) used as Class Map variable defaults. */
export function parseMapDefaultEntries(value: unknown): MapDefaultEntry[] {
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entryValue]) => ({
      key,
      value: entryValue,
    }));
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isMapDefaultEntry).map((entry) => ({
    key: entry.key,
    value: entry.value,
  }));
}

/** Spawn / runtime Map. Later duplicate keys win. */
export function mapFromDefaultEntries(value: unknown): Map<unknown, unknown> {
  const map = new Map<unknown, unknown>();
  for (const entry of parseMapDefaultEntries(value)) {
    map.set(entry.key, entry.value);
  }
  return map;
}

/** Function-local initializer for a Map variable default. */
export function mapDefaultLiteral(value: unknown): string {
  const entries = parseMapDefaultEntries(value);
  if (entries.length === 0) return "new Map()";
  return `new Map(${JSON.stringify(entries.map((entry) => [entry.key, entry.value]))})`;
}
