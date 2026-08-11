/**
 * Reversible document mutation (engineplan §7.3 / command-layer.md).
 * Editing surfaces must not mutate document models except through apply.
 */
export interface EditCommand<TDoc = unknown> {
  readonly type: string;
  /** Coalesce continuous gestures (node drag, slider scrub). */
  readonly mergeKey?: string;
  apply(doc: TDoc): TDoc;
  invert(): EditCommand<TDoc>;
  /** Snapshot-fallback cost in bytes; omit for compact deltas. */
  readonly byteSize?: number;
}

export interface StackEntry<TDoc> {
  /** Forward command (latest in a merge group). */
  command: EditCommand<TDoc>;
  /** Inverse that restores state before the first apply of this merge group. */
  inverse: EditCommand<TDoc>;
}
