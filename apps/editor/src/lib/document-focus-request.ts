import { useEffect, type RefObject } from "react";

/** A request that no document claims within this time is dropped. */
const REQUEST_LIFETIME_MS = 3000;

let pending: { id: string; expires: number } | null = null;
const listeners = new Set<() => void>();

/**
 * Ask for keyboard focus to move into a document once it is the active tab.
 * The request is held until that tab's shell mounts or activates, because a
 * document that was just opened gets there a render later.
 */
export function requestDocumentFocus(id: string): void {
  pending = { id, expires: performance.now() + REQUEST_LIFETIME_MS };
  for (const listener of [...listeners]) listener();
}

/** Focuses `ref` for a pending request naming `id`, while its document is active. */
export function useDocumentFocusRequest(
  id: string,
  active: boolean,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const take = () => {
      if (pending?.id !== id) return;
      const live = performance.now() < pending.expires;
      pending = null;
      const element = ref.current;
      if (!live || !element) return;
      // Programmatic focus only: the shell never becomes a Tab stop.
      if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
      element.focus({ preventScroll: true });
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [active, id, ref]);
}
