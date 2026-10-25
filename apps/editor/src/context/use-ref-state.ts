import { useCallback, useState, type RefObject } from "react";

/**
 * React state mirrored in `ref` for callbacks that read it when they run.
 * The setter writes both together, never during render, so a callback called
 * later in the same event (or from a child's layout effect before this
 * provider commits) already sees the new value without depending on it.
 */
export function useRefState<T>(
  ref: RefObject<T>,
): [T, (next: T | ((current: T) => T)) => void] {
  const [state, setState] = useState(ref.current);
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      const value =
        typeof next === "function"
          ? (next as (current: T) => T)(ref.current)
          : next;
      ref.current = value;
      setState(value);
    },
    [ref],
  );
  return [state, set];
}
