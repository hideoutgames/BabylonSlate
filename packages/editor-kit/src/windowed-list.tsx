import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WINDOWED_SLICE_OVERSCAN, windowedSlice } from "./windowed-slice";

/** Matches `--touch-target` for catalog and Compiler Results rows. */
export const WINDOWED_LIST_TOUCH_ROW_HEIGHT = 44;

const VIEWPORT_SLOT = '[data-slot="scroll-area-viewport"]';

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
    const viewport = listRef.current?.closest(VIEWPORT_SLOT);
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
