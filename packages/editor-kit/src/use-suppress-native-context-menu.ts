import { useEffect } from "react";

/**
 * Editable fields and opted-in selectable text keep the platform menu, since
 * that is where cut/copy/paste and the iOS text callout are still wanted.
 */
function keepsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .selectable-text"),
  );
}

/**
 * Suppresses the platform context menu across the app so long-press and
 * right-click open our own menus instead of the browser or iOS callout.
 */
export function useSuppressNativeContextMenu(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onContextMenu = (event: MouseEvent) => {
      if (keepsNativeMenu(event.target)) return;
      event.preventDefault();
    };

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [enabled]);
}
