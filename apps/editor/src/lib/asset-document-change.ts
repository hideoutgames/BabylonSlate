function isJsonPropertyValue(value: unknown): boolean {
  return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

/** Fast early-exit structural equality matching JSON serialization semantics. */
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    // JSON.stringify turns NaN and +/-Infinity into null.
    return !Number.isFinite(left) && !Number.isFinite(right);
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      const a = isJsonPropertyValue(left[index]) ? left[index] : null;
      const b = isJsonPropertyValue(right[index]) ? right[index] : null;
      if (!jsonValuesEqual(a, b)) return false;
    }
    return true;
  }
  if (Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  let aCount = 0;
  for (let index = 0; index < aKeys.length; index++) {
    const key = aKeys[index]!;
    const aVal = a[key];
    if (!isJsonPropertyValue(aVal)) continue;
    aCount += 1;
    const bVal = b[key];
    if (!isJsonPropertyValue(bVal) || !jsonValuesEqual(aVal, bVal)) return false;
  }
  let bCount = 0;
  for (let index = 0; index < bKeys.length; index++) {
    if (isJsonPropertyValue(b[bKeys[index]!])) bCount += 1;
  }
  return aCount === bCount;
}

/** True when an asset-tab commit would actually change the persisted payload. */
export function shouldApplyAssetDocumentChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  // Payloads are replaced on edit, never changed in place: the same object is no edit.
  if (previous === next) return false;
  return !jsonValuesEqual(previous, next);
}
