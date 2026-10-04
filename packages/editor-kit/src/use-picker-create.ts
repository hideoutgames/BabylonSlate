import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Shared create-then-pick flow for picker "Create New" rows. The pick runs after
 * the render that follows creation, so `onPick` sees the refreshed asset list.
 * Closing the dialog while a create is pending drops that pick.
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
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(0);
  const latest = useRef({ onOpenChange, onPick });
  useLayoutEffect(() => {
    latest.current = { onOpenChange, onPick };
  });
  useLayoutEffect(() => {
    if (open) return;
    session.current += 1;
    setCreatingId(null);
    setCreatedId(null);
    setError(null);
  }, [open]);
  useEffect(() => {
    if (createdId === null) return;
    setCreatedId(null);
    setCreatingId(null);
    latest.current.onPick(createdId);
    latest.current.onOpenChange(false);
  }, [createdId]);

  const run = async (rowId: string, create: () => Promise<string>) => {
    if (creatingId !== null) return;
    const started = session.current;
    setCreatingId(rowId);
    setError(null);
    try {
      const id = await create();
      if (session.current === started) setCreatedId(id);
    } catch (cause) {
      if (session.current !== started) return;
      setCreatingId(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return { creatingId, error, run };
}
