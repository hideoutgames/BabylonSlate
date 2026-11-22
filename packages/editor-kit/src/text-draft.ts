import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";

/**
 * A local draft of `value` that commits once, not per keystroke. `commit`
 * calls `onCommit(draft)` when the draft differs from `value` (and was not just
 * committed); a `value` that changes from outside (Undo, another editor, a
 * reload) replaces the draft, even while the user is in the field. A pending
 * draft commits on unmount.
 */
export function useTextDraft(value: string, onCommit: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const latest = useRef({ draft, value, onCommit });
  // The draft last handed to `onCommit` while `value` has not caught up yet.
  const committed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (latest.current.value !== value) committed.current = null;
    latest.current = { draft, value, onCommit };
  });
  const commit = useCallback(() => {
    const current = latest.current;
    if (current.draft === current.value || current.draft === committed.current) return;
    committed.current = current.draft;
    current.onCommit(current.draft);
  }, []);
  useEffect(() => () => commit(), [commit]);
  return { draft, setDraft, commit };
}

/** A blur handler that ignores focus moving within the element (completion lists, tooltips). */
export function commitOnFocusLeave(commit: () => void) {
  return (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    commit();
  };
}
