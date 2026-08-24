import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WINDOWED_SLICE_OVERSCAN, windowedSlice } from "./windowed-slice";

/** Matches `--touch-target` for catalog and Compiler Results rows. */
export const WINDOWED_LIST_TOUCH_ROW_HEIGHT = 44;

/** 16rem — Tailwind `h-64`. Content-sized dialogs cannot grow `h-0 flex-1`. */
export const PICKER_LIST_MAX_HEIGHT_PX = 256;

/** Definite list height for SearchDialog / AddFunctionDialog pickers. */
export function pickerListHeightPx(itemCount: number): number {
  if (itemCount <= 0) return WINDOWED_LIST_TOUCH_ROW_HEIGHT;
  return Math.min(
    PICKER_LIST_MAX_HEIGHT_PX,
    itemCount * WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  );
}

const VIEWPORT_SLOT = '[data-slot="scroll-area-viewport"]';

function isOverflowScroll(el: Element): boolean {
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/** ScrollArea viewport if present; otherwise nearest overflow-y auto/scroll ancestor. */
export function findWindowedListScrollParent(
  el: Element | null,
): HTMLElement | null {
  if (!el) return null;
  const viewport = el.closest(VIEWPORT_SLOT);
  if (viewport instanceof HTMLElement) return viewport;
  let current: Element | null = el.parentElement;
  while (current) {
    if (isOverflowScroll(current) && current instanceof HTMLElement) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export type WindowedListProps = {
  itemCount: number;
  rowHeight: number;
  children: (index: number) => ReactNode;
};

export function WindowedList({
  itemCount,
  rowHeight,
  children,
}: WindowedListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const viewport = findWindowedListScrollParent(listRef.current);
    if (!(viewport instanceof HTMLElement)) return;
    const read = () => {
      setViewportHeight(viewport.clientHeight);
      setScrollTop(viewport.scrollTop);
    };
    read();
    const onScroll = () => setScrollTop(viewport.scrollTop);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [itemCount]);

  const { firstIndex, lastIndex } = windowedSlice({
    itemCount,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan: WINDOWED_SLICE_OVERSCAN,
  });

  const rows: number[] = [];
  for (let index = firstIndex; index < lastIndex; index++) {
    rows.push(index);
  }

  return (
    <div
      ref={listRef}
      className="relative"
      style={{ height: itemCount * rowHeight }}
    >
      {rows.map((index) => (
        <div
          key={index}
          className="absolute right-0 left-0 overflow-hidden"
          style={{ top: index * rowHeight, height: rowHeight }}
        >
          {children(index)}
        </div>
      ))}
    </div>
  );
}
