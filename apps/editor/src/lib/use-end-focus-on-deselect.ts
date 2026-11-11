import { useEffect, useRef } from "react";

/**
 * A navigation focus (a Compiler Results row, a Session Report entry) lasts
 * while the user keeps its target selected. Once the target has been selected,
 * a selection without it ends the focus: the user has moved on, so the
 * Inspector and Compiler Results stop holding it, and choosing the row again
 * navigates afresh.
 */
export function useEndFocusOnDeselect(
  targetId: string | undefined,
  selectedIds: readonly string[],
  end: () => void,
): void {
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!targetId) {
      applied.current = undefined;
      return;
    }
    if (selectedIds.includes(targetId)) {
      applied.current = targetId;
      return;
    }
    if (applied.current !== targetId) return;
    applied.current = undefined;
    end();
  }, [end, selectedIds, targetId]);
}
