import { useEffect } from "react";

/**
 * The boot intro that index.html paints outside #root before the bundle runs.
 * React never renders it, so it plays on uninterrupted until released.
 */
function bootIntro(): HTMLElement | null {
  return document.getElementById("haptic-intro");
}

/** When the intro's timeline started, or null when there is no intro. */
export function bootIntroStart(): number | null {
  const start = Number(bootIntro()?.dataset.start);
  return Number.isFinite(start) && start > 0 ? start : null;
}

/** Removes the intro, for example so an error screen is not covered. */
export function releaseBootIntro() {
  bootIntro()?.remove();
}

/**
 * Drives the intro while the boot transition runs (`state`), reports the end
 * of its fade, and releases it once the transition is over (`null`).
 */
export function useBootIntro(
  state: { leaving: boolean; label: string; status: string } | null,
  onFadeEnd: () => void,
) {
  const active = state !== null;
  useEffect(() => {
    const intro = bootIntro();
    if (!intro) return;
    if (!active) {
      releaseBootIntro();
      return;
    }
    const finish = (event: TransitionEvent) => {
      if (event.target === intro && event.propertyName === "opacity")
        onFadeEnd();
    };
    intro.addEventListener("transitionend", finish);
    return () => intro.removeEventListener("transitionend", finish);
  }, [active, onFadeEnd]);
  const leaving = state?.leaving;
  const label = state?.label;
  const status = state?.status;
  useEffect(() => {
    const intro = bootIntro();
    if (!intro || leaving === undefined) return;
    intro.dataset.leaving = String(leaving);
    if (label) intro.setAttribute("aria-label", label);
    const statusText = intro.querySelector(".haptic-intro-status");
    if (statusText && status) statusText.textContent = status;
  }, [leaving, label, status]);
}
