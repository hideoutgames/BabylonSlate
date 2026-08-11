export type ScrollAxis = "x" | "y";

/** Returns whether an element can scroll along the given axis. */
export function isScrollableAxis(el: Element, axis: ScrollAxis): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") {
    return false;
  }
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
  if (!isScrollableAxis(el, axis)) return false;

  if (axis === "y") {
    const atTop = el.scrollTop <= 0;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (delta > 0) return !atTop;
    if (delta < 0) return !atBottom;
    return false;
  }

  const atLeft = el.scrollLeft <= 0;
  const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  if (delta > 0) return !atLeft;
  if (delta < 0) return !atRight;
  return false;
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

  let el: Element | null = target;
  while (el && el !== document.documentElement) {
    if (canScrollInDirection(el, "y", deltaY)) return false;
    if (canScrollInDirection(el, "x", deltaX)) return false;
    el = el.parentElement;
  }

  return true;
}

export function isCoarsePointerEnvironment(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}
