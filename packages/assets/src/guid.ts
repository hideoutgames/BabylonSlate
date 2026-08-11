/** Generate a new asset guid, preferring the platform crypto API. */
export function newAssetGuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `guid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
