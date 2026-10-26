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
 * Labels the intro while the boot transition runs (`state`), and removes it
 * at once when the transition is over (`null`); it never fades.
 */
export function useBootIntro(
  state: { label: string; status: string } | null,
) {
  const active = state !== null;
  useEffect(() => {
    if (!active) releaseBootIntro();
  }, [active]);
  const label = state?.label;
  const status = state?.status;
  useEffect(() => {
    const intro = bootIntro();
    if (!intro) return;
    if (label) intro.setAttribute("aria-label", label);
    const statusText = intro.querySelector(".haptic-intro-status");
    if (statusText && status) statusText.textContent = status;
  }, [label, status]);
}
