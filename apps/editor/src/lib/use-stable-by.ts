import { useRef } from "react";

/**
 * `value`, or the one returned before while `same(previous, value)` holds, so
 * memos keyed on the result skip changes that do not matter to them.
 */
export function useStableBy<T>(value: T, same: (previous: T, next: T) => boolean): T {
  const kept = useRef(value);
  if (kept.current !== value && !same(kept.current, value)) kept.current = value;
  return kept.current;
}
