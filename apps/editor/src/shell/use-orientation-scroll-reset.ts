import { useEffect } from "react";

// WebKit can deliver viewport resizes after the orientation event. Stop after
// one second so ordinary keyboard resizing keeps its native scroll behavior.
const ORIENTATION_SETTLE_MS = 1_000;

/** Recover the app shell from a document offset retained during phone rotation. */
export function useOrientationScrollReset(): void {
  useEffect(() => {
    const orientation = window.screen.orientation;
    const viewport = window.visualViewport;
    let recovering = false;
    let frame: number | undefined;
    let deadline: number | undefined;

    const scheduleReset = () => {
      if (!recovering || frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        window.scrollTo(0, 0);
        for (const element of new Set([
          document.scrollingElement,
          document.documentElement,
          document.body,
          document.getElementById("root"),
        ])) {
          if (!element) continue;
          element.scrollTop = 0;
          element.scrollLeft = 0;
        }
      });
    };

    const beginRecovery = () => {
      recovering = true;
      window.clearTimeout(deadline);
      deadline = window.setTimeout(() => {
        recovering = false;
      }, ORIENTATION_SETTLE_MS);
      scheduleReset();
    };

    window.addEventListener("orientationchange", beginRecovery);
    orientation?.addEventListener("change", beginRecovery);
    window.addEventListener("resize", scheduleReset);
    viewport?.addEventListener("resize", scheduleReset);
    return () => {
      window.removeEventListener("orientationchange", beginRecovery);
      orientation?.removeEventListener("change", beginRecovery);
      window.removeEventListener("resize", scheduleReset);
      viewport?.removeEventListener("resize", scheduleReset);
      window.clearTimeout(deadline);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);
}
