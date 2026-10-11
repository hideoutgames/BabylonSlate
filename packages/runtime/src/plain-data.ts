/**
 * Structural equality of plain data (primitives, arrays and plain objects),
 * so a per-tick change check allocates no comparison string. NaN equals NaN.
 */
export function samePlainData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, index) => samePlainData(value, other[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && samePlainData(left[key], right[key]));
}

/**
 * Copy of the arrays and plain objects inside `value`. Any other object, such as
 * a live actor or component, stays the same reference.
 */
export function copyPlainData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyPlainData) as T;
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyPlainData(entry)])) as T;
}
