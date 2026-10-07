import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Shared create-then-pick flow for picker "Create New" rows. The pick runs after
 * the render that follows creation, so `onPick` sees the refreshed asset list.
 * Closing the dialog while a create is pending drops that pick; closing also
 * clears the finished create, so the row stays busy until the picker closes.
 */
export function usePickerCreate({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string) => void;
}) {
  const [creatingId, setCreatingId] = useState<string | null>(null);
  /** A fresh object per creation so repeating an id still delivers a pick. */
  const [created, setCreated] = useState<{ id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(0);
  const latest = useRef({ onOpenChange, onPick });
  useLayoutEffect(() => {
    latest.current = { onOpenChange, onPick };
  });
  // Closing resets the flow while rendering; the session bump drops a pending create.
  const [wasOpen, setWasOpen] = useState<boolean | null>(null);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setCreatingId(null);
      setCreated(null);
      setError(null);
    }
  }
  useLayoutEffect(() => {
    if (!open) session.current += 1;
  }, [open]);
  useEffect(() => {
    if (created === null) return;
    latest.current.onPick(created.id);
    latest.current.onOpenChange(false);
  }, [created]);

  const run = async (rowId: string, create: () => Promise<string>) => {
    if (creatingId !== null && created === null) return;
    const started = session.current;
    setCreatingId(rowId);
    setCreated(null);
    setError(null);
    try {
      const id = await create();
      if (session.current === started) setCreated({ id });
    } catch (cause) {
      if (session.current !== started) return;
      setCreatingId(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return { creatingId, error, run };
}
