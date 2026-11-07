type IndexedEntry = { path: string; header: { guid?: string } };

/**
 * A test registry with `AssetRegistry`'s lookups: `list` plus the guid and
 * path lookups the real registry keeps in step with it. Pass a function to
 * keep entries live when a test changes them between renders.
 */
export function indexedAssetRegistry<T extends IndexedEntry>(entries: readonly T[] | (() => readonly T[])) {
  const read = typeof entries === "function" ? entries : () => entries;
  return {
    list: () => [...read()],
    getByGuid: (guid: string) => read().find((entry) => entry.header.guid === guid),
    getByPath: (path: string) => read().find((entry) => entry.path === path),
  };
}
