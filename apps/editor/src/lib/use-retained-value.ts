import { useEffect, useRef } from "react";

/**
 * `value` while there is one; once it becomes `null`, the last value it had
 * (`initial` before the first). A dialog computes its content only while open
 * (`open ? build() : null`) and passes the result here, so it costs nothing
 * while closed yet keeps its content on screen while it fades out.
 */
export function useRetainedValue<T>(value: T | null, initial: T): T {
  const retained = useRef(initial);
  useEffect(() => {
    if (value !== null) retained.current = value;
  }, [value]);
  return value ?? retained.current;
}
