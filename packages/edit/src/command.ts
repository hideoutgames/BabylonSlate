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
  /** Snapshot cost in bytes; required in both directions for history admission. */
  readonly byteSize?: number;
}

export interface StackEntry<TDoc> {
  /** Forward command (latest in a merge group). */
  command: EditCommand<TDoc>;
  /** Inverse that restores state before the first apply of this merge group. */
  inverse: EditCommand<TDoc>;
}
