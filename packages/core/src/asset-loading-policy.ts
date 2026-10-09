/**
 * Loading policy of an asset or Class reference declared by a Class variable,
 * Structure field or Data Definition field.
 *
 * - `soft` (Load On Demand, the default): packaged and rename-safe, recorded in
 *   the owner's `dependencies`, but never loaded with the owner.
 * - `hard` (Load With Owner): part of the owner's required closure.
 *
 * Only `"hard"` is persisted, in the declaration's `loading` property; Soft is
 * the absence of that property.
 */
export type AssetLoadingPolicy = "soft" | "hard";

/** Persisted policy carried by a declaration that owns asset or Class references. */
export interface AssetLoadingDeclaration {
  loading?: "hard";
}

export function isHardLoading(value: { loading?: unknown } | null | undefined): boolean {
  return value?.loading === "hard";
}

export function assetLoadingPolicy(value: { loading?: unknown } | null | undefined): AssetLoadingPolicy {
  return isHardLoading(value) ? "hard" : "soft";
}

/** Spread into a persisted declaration: keeps Hard and drops everything else. */
export function hardLoadingProperty(value: { loading?: unknown } | null | undefined): AssetLoadingDeclaration {
  return isHardLoading(value) ? { loading: "hard" } : {};
}

/** Asset and Class values, including the keys of a Map, are the references that own a policy. */
export function carriesLoadingPolicy(
  declaration: { typeId?: unknown; container?: unknown; keyTypeId?: unknown },
): boolean {
  const reference = (typeId: unknown) => typeId === "asset" || typeId === "class";
  return reference(declaration.typeId) || (declaration.container === "map" && reference(declaration.keyTypeId));
}
