/**
 * Reversible document mutation (engineplan §7.3 / command-layer.md).
 * Editing surfaces must not mutate document models except through apply.
 */
export interface EditCommand<TDoc = unknown> {
  readonly type: string;
  /** Coalesce continuous gestures (node drag, slider scrub). */
  readonly mergeKey?: string;
  /** Pure document replacement: never mutate the input or external state. */
  apply(doc: TDoc): TDoc;
  invert(): EditCommand<TDoc>;
  /**
   * Fold the next command of the same gesture into one command running from
   * this command's start to `next`'s end, so a merged Undo entry retains only
   * the first `from` and the last `to`. Undefined keeps the default merge
   * (first inverse plus latest forward command).
   */
  coalesce?(next: EditCommand<TDoc>): EditCommand<TDoc> | undefined;
  /**
   * Snapshot cost in bytes; required in both directions for history
   * admission. Commands measure it lazily: only Undo history reads it.
   */
  readonly byteSize?: number;
}

export interface StackEntry<TDoc> {
  /** Forward command (latest in a merge group). */
  command: EditCommand<TDoc>;
  /** Inverse that restores state before the first apply of this merge group. */
  inverse: EditCommand<TDoc>;
}
