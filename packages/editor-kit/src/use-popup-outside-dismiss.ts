import { useEffect, useLayoutEffect, useRef } from "react";

/** Marks the element a popup picker treats as "inside" for outside-press dismissal. */
export const POPUP_PICKER_ATTRIBUTE = "data-popup-picker";

/**
 * Closes a popup picker on any press outside it, before other handlers run.
 * Pickers often open inside another dialog (New Asset, Settings), where a
 * nested dialog gets no backdrop and the host's outside-press never reaches it.
 */
export function usePopupOutsideDismiss(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const dismissFromOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(`[${POPUP_PICKER_ATTRIBUTE}]`)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", dismissFromOutside, true);
    return () => document.removeEventListener("pointerdown", dismissFromOutside, true);
  }, [open]);
}
