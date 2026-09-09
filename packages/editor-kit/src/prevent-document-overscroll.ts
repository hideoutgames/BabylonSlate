import { keepsNativeEditing } from "./ios-editing-gestures";

export type ScrollAxis = "x" | "y";

function allowsScrollOverflow(style: CSSStyleDeclaration, axis: ScrollAxis) {
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/** Returns whether an element can scroll along the given axis. */
export function isScrollableAxis(el: Element, axis: ScrollAxis): boolean {
  if (!allowsScrollOverflow(getComputedStyle(el), axis)) return false;
  return axis === "y"
    ? el.scrollHeight > el.clientHeight
    : el.scrollWidth > el.clientWidth;
}

/** Whether a scrollable element can absorb movement in the drag direction. */
export function canScrollInDirection(
  el: Element,
  axis: ScrollAxis,
  delta: number,
): boolean {
  if (delta === 0) return false;
  return canAbsorbScroll(el, axis, delta, getComputedStyle(el));
}

function canAbsorbScroll(
  el: Element,
  axis: ScrollAxis,
  delta: number,
  style: CSSStyleDeclaration,
): boolean {
  if (!allowsScrollOverflow(style, axis)) return false;
  const maximum =
    axis === "y"
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth;
  if (maximum <= 0) return false;
  const offset = axis === "y" ? el.scrollTop : el.scrollLeft;
  return delta > 0 ? offset > 0 : offset < maximum - 1;
}

/**
 * Walks from the touch target up to the document root. Returns true when the
 * gesture should be blocked to prevent document rubber-band overscroll.
 */
export function shouldPreventDocumentOverscroll(
  target: EventTarget | null,
  deltaX: number,
  deltaY: number,
): boolean {
  if (!(target instanceof Element)) return true;
  if (keepsNativeEditing(target)) return false;
  if (deltaX === 0 && deltaY === 0) return true;

  let el: Element | null = target;
  while (el && el !== document.documentElement) {
    // Read current styles once per ancestor, without caching across layout or
    // dialog changes. Stationary axes do not need geometry reads.
    const style = getComputedStyle(el);
    if (deltaY !== 0 && canAbsorbScroll(el, "y", deltaY, style)) return false;
    if (deltaX !== 0 && canAbsorbScroll(el, "x", deltaX, style)) return false;
    el = el.parentElement;
  }

  return true;
}

export function isCoarsePointerEnvironment(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}
