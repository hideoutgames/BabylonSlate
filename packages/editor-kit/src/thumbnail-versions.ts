import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-asset thumbnail versions: an asset's version changes when its stored
 * thumbnail is rewritten. Readers subscribe to the assets they show, so a
 * rewrite renders only the views that show that asset.
 */
export type ThumbnailVersions = {
  version(guid: string): number;
  /** Calls `listener` after `guid`'s version changes. */
  subscribe(guid: string, listener: () => void): () => void;
};

/** The writable `ThumbnailVersions` a thumbnail owner keeps. */
export type ThumbnailVersionStore = ThumbnailVersions & {
  /** Advances each asset's version and notifies its listeners. */
  bump(guids: Iterable<string>): void;
  /** Every version back to 0 (a project switch); every listener is notified. */
  reset(): void;
};

export function createThumbnailVersionStore(): ThumbnailVersionStore {
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (guid: string) => {
    const set = listeners.get(guid);
    if (set) for (const listener of [...set]) listener();
  };
  return {
    version: (guid) => versions.get(guid) ?? 0,
    subscribe(guid, listener) {
      let set = listeners.get(guid);
      if (!set) listeners.set(guid, set = new Set());
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(guid) === set) listeners.delete(guid);
      };
    },
    bump(guids) {
      const changed = [...new Set(guids)];
      for (const guid of changed) versions.set(guid, (versions.get(guid) ?? 0) + 1);
      for (const guid of changed) notify(guid);
    },
    reset() {
      const shown = [...versions.keys()];
      versions.clear();
      for (const guid of shown) notify(guid);
    },
  };
}

const noSubscription = () => () => {};

/** `guid`'s thumbnail version; the caller renders again only when it changes. */
export function useThumbnailVersion(versions: ThumbnailVersions | null | undefined, guid: string | null | undefined): number {
  const subscribe = useCallback(
    (listener: () => void) => versions && guid ? versions.subscribe(guid, listener) : () => {},
    [versions, guid],
  );
  const read = () => (versions && guid ? versions.version(guid) : 0);
  return useSyncExternalStore(versions && guid ? subscribe : noSubscription, read, read);
}

/**
 * `guid:version` for each of `guids`, joined with `|`, or `""` while disabled.
 * The caller renders again only when one of these assets' versions changes.
 */
export function useThumbnailVersionsKey(
  versions: ThumbnailVersions | null | undefined,
  guids: readonly string[],
  enabled = true,
): string {
  const active = Boolean(versions) && enabled;
  const subscribe = useCallback((listener: () => void) => {
    if (!versions || !active) return () => {};
    const unsubscribe = guids.map((guid) => versions.subscribe(guid, listener));
    return () => { for (const off of unsubscribe) off(); };
  }, [versions, guids, active]);
  const read = () => (versions && active ? guids.map((guid) => `${guid}:${versions.version(guid)}`).join("|") : "");
  return useSyncExternalStore(subscribe, read, read);
}
