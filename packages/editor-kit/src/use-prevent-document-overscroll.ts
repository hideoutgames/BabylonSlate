import { useEffect } from "react";
import {
  isCoarsePointerEnvironment,
  isScrollableAxis,
  shouldPreventDocumentOverscroll,
} from "./prevent-document-overscroll";

// #region agent log
let agentOverscrollN = 0;
function agentDbg(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  const payload = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    hypothesisId,
    location,
    message,
    data,
  };
  console.debug("[agent-dbg]", payload);
  if (typeof fetch === "function") {
    void fetch("/__agent_debug_log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `${JSON.stringify(payload)}\n`,
      keepalive: true,
    }).catch(() => {});
  }
}
// #endregion

/**
 * Blocks iOS Safari document rubber-band overscroll on coarse pointers while
 * allowing designated scroll regions (content browser, tab bar, homepage) to
 * scroll normally. CSS `overflow: hidden` on the shell is the primary lock;
 * this hook is the touch-event fallback for WebKit edge cases.
 */
export function usePreventDocumentOverscroll(enabled = true): void {
  useEffect(() => {
    if (!enabled || !isCoarsePointerEnvironment()) return;

    let startX = 0;
    let startY = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const deltaX = event.touches[0].clientX - startX;
      const deltaY = event.touches[0].clientY - startY;
      const prevent = shouldPreventDocumentOverscroll(
        event.target,
        deltaX,
        deltaY,
      );
      // #region agent log
      const target = event.target;
      const inTree =
        target instanceof Element &&
        Boolean(target.closest('[data-testid="content-browser-folder-tree"]'));
      if (inTree && agentOverscrollN <= 12) {
        agentOverscrollN += 1;
        const tree = target.closest(
          '[data-testid="content-browser-folder-tree"]',
        );
        agentDbg("E", "use-prevent-document-overscroll.ts:touchmove", "overscroll gate", {
          n: agentOverscrollN,
          prevent,
          deltaY,
          treeScrollableY: tree ? isScrollableAxis(tree, "y") : null,
          treeScrollHeight: tree instanceof HTMLElement ? tree.scrollHeight : null,
          treeClientHeight: tree instanceof HTMLElement ? tree.clientHeight : null,
          defaultPreventedBefore: event.defaultPrevented,
        });
      }
      // #endregion
      if (prevent) {
        event.preventDefault();
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, [enabled]);
}
