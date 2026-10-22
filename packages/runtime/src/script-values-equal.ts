/** Nesting compared before giving up; plain script data is shallow, so this only stops a self-referencing value. */
const MAX_DEPTH = 32;

/** Object literals: vectors, rotators, colors, transforms and structures, as compiled graphs build them. */
function isPlainData(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

/**
 * Assert Equal's comparison. Numbers, text, booleans, enums and tags must be identical. Vectors,
 * structures and other plain data compare field by field, Arrays item by item and Maps entry by
 * entry. Any other object, such as an actor or component, is equal only to itself.
 */
export function scriptValuesEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || depth >= MAX_DEPTH) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, index) => scriptValuesEqual(item, b[index], depth + 1));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) {
      let matched = false;
      for (const [otherKey, otherValue] of b) {
        if (!scriptValuesEqual(key, otherKey, depth + 1)) continue;
        matched = scriptValuesEqual(value, otherValue, depth + 1);
        break;
      }
      if (!matched) return false;
    }
    return true;
  }
  if (!isPlainData(a) || !isPlainData(b)) return false;
  const fields = Object.keys(a);
  if (fields.length !== Object.keys(b).length) return false;
  return fields.every((field) => Object.prototype.hasOwnProperty.call(b, field)
    && scriptValuesEqual((a as Record<string, unknown>)[field], (b as Record<string, unknown>)[field], depth + 1));
}
