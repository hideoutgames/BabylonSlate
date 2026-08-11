import { newGuid } from "@babylonslate/core";

/** Generate a new asset guid, preferring the platform crypto API. */
export function newAssetGuid(): string {
  return newGuid();
}
