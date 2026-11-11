/**
 * One render's edit access to an asset document for its Inspector. Row
 * callbacks read the document with `read()` and change it with `write()`;
 * outside a batch those are the rendered document and an immediate commit.
 */
export interface DocumentBatch<T> {
  read: () => T;
  write: (next: T, mergeKey?: string) => void;
  /**
   * Runs a multi-selection edit's per-item changes (`mergePropertyRows`'
   * `batch`) against one working copy and commits it once: one document
   * change and one undo step, where no item's change overwrites another's.
   */
  batch: (apply: () => void) => void;
}

/**
 * The batch's merge key: the items' own keys together, so a scrub or typed
 * edit of several items stays one undo step; none when any item's change is
 * a discrete edit.
 */
function batchMergeKey(keys: readonly (string | undefined)[]): string | undefined {
  if (keys.some((key) => key === undefined)) return undefined;
  return `selection:${[...new Set(keys)].sort().join("|")}`;
}

export function documentBatch<T>(
  document: T,
  commit: (next: T, mergeKey?: string) => void,
): DocumentBatch<T> {
  let open: { working: T; keys: (string | undefined)[] } | null = null;
  return {
    read: () => (open ? open.working : document),
    write: (next, mergeKey) => {
      if (!open) {
        commit(next, mergeKey);
        return;
      }
      open.working = next;
      open.keys.push(mergeKey);
    },
    batch: (apply) => {
      if (open) {
        apply();
        return;
      }
      const current: { working: T; keys: (string | undefined)[] } = { working: document, keys: [] };
      open = current;
      try {
        apply();
      } finally {
        open = null;
      }
      if (current.keys.length > 0) commit(current.working, batchMergeKey(current.keys));
    },
  };
}
