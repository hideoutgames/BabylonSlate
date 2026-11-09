/**
 * Reduce Motion (Engine Settings → Accessibility): `data-reduced-motion` on
 * the root element turns off non-essential animation. The boot script sets it
 * from the device setting; the editor then sets it from Reduce Motion
 * (System follows the device). The `motion-reduce:` and `motion-safe:`
 * Tailwind variants and the reduced-motion CSS rules read it.
 */
import { useSyncExternalStore } from "react";

const REDUCED_MOTION_ATTRIBUTE = "data-reduced-motion";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const listeners = new Set<() => void>();

/** The device's own reduced-motion preference. */
export function systemPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function setReducedMotion(reduced: boolean): void {
  if (typeof document === "undefined" || prefersReducedMotion() === reduced) return;
  document.documentElement.toggleAttribute(REDUCED_MOTION_ATTRIBUTE, reduced);
  for (const listener of listeners) listener();
}

/** Whether animation should be reduced now: the root attribute, which the editor keeps current. */
export function prefersReducedMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(REDUCED_MOTION_ATTRIBUTE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while animation is reduced; re-renders when Reduce Motion or the device setting changes it. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/** Calls `listener` when the device's reduced-motion preference changes. */
export function subscribeSystemReducedMotion(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
