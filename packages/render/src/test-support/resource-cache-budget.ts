import type { ResourceCache, ResourceLease } from "../resource-cache";

/** The view whose budget `setTestTextureBudget` sets: the cache has no budget of its own, only its views'. */
const testView = {};

/** Gives `cache` a texture budget of `bytes`, as one view's owner does (`ResourceCacheOwner.setByteCeiling`). */
export function setTestTextureBudget(cache: ResourceCache, bytes: number): void {
  cache.setClientBudget(testView, bytes);
}

/**
 * An entry accounted at `bytes` with no texture allocated, held until the returned lease is released: something for
 * eviction and budgets to act on.
 */
export function accountedEntry(cache: ResourceCache, guid: string, bytes: number): ResourceLease<string> {
  const lease = cache.acquireBlobUrl(guid, new Uint8Array(0));
  cache.account(guid, bytes);
  return lease;
}
