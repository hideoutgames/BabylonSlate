import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  WINDOWED_SLICE_OVERSCAN,
  windowedRowOffsets,
  windowedSlice,
} from "./windowed-slice";

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
  return (
    overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay"
  );
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
  /** One height for every row, or a per-row height (e.g. compact group headers). */
  rowHeight: number | ((index: number) => number);
  /** Keep a keyboard target mounted and reveal it without moving DOM focus. */
  activeIndex?: number;
  children: (index: number) => ReactNode;
};

export function WindowedList({
  itemCount,
  rowHeight,
  activeIndex = -1,
  children,
}: WindowedListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rowOffsets =
    typeof rowHeight === "function"
      ? windowedRowOffsets(itemCount, rowHeight)
      : undefined;
  const rowTop = (index: number) =>
    rowOffsets ? rowOffsets[index]! : index * (rowHeight as number);
  const rowSize = (index: number) =>
    rowOffsets ? rowOffsets[index + 1]! - rowOffsets[index]! : (rowHeight as number);
  const totalHeight = rowOffsets ? rowOffsets[itemCount]! : itemCount * (rowHeight as number);
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

  useLayoutEffect(() => {
    if (activeIndex < 0 || activeIndex >= itemCount) return;
    const viewport = findWindowedListScrollParent(listRef.current);
    if (!viewport || viewport.clientHeight === 0) return;
    const bounds = listRef.current?.getBoundingClientRect();
    const listTop =
      bounds && bounds.height > 0
        ? bounds.top - viewport.getBoundingClientRect().top + viewport.scrollTop
        : 0;
    const top = listTop + rowTop(activeIndex);
    const bottom = top + rowSize(activeIndex);
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = bottom - viewport.clientHeight;
    setScrollTop(viewport.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- row geometry derives from rowHeight.
  }, [activeIndex, itemCount, rowHeight]);

  const { firstIndex, lastIndex } = windowedSlice({
    itemCount,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan: WINDOWED_SLICE_OVERSCAN,
    rowOffsets,
  });

  const rows: number[] = [];
  for (let index = firstIndex; index < lastIndex; index++) {
    rows.push(index);
  }
  if (
    activeIndex >= 0 &&
    activeIndex < itemCount &&
    !rows.includes(activeIndex)
  ) {
    rows.push(activeIndex);
    rows.sort((a, b) => a - b);
  }

  return (
    <div
      ref={listRef}
      className="relative"
      style={{ height: totalHeight }}
    >
      {rows.map((index) => (
        <div
          key={index}
          className="absolute right-0 left-0 overflow-hidden touch-pan-y"
          style={{ top: rowTop(index), height: rowSize(index) }}
        >
          {children(index)}
        </div>
      ))}
    </div>
  );
}
