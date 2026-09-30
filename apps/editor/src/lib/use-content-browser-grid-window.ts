import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  clampGridSlice,
  contentBrowserGridHeight,
  sameGridSlice,
  unboundedGridWindow,
  type WindowedGridSlice,
} from "./content-browser-grid";

/** Unmeasured viewport: mount every tile (jsdom / first paint). */
const UNMEASURED_WINDOW: WindowedGridSlice = {
  firstIndex: 0,
  lastIndex: Number.POSITIVE_INFINITY,
  columnCount: 1,
};

/**
 * Windowed tile range for the Content Browser grid. State holds the
 * row-quantized window rather than `scrollTop`, so scrolling inside a row does
 * not re-render the grid. A hidden browser mounts no tiles and keeps its last
 * column count (stable spacer height); it re-measures when shown.
 */
export function useContentBrowserGridWindow(
  itemCount: number,
  hidden: boolean,
): {
  scrollerRef: RefObject<HTMLDivElement | null>;
  slice: WindowedGridSlice;
  spacerHeight: number;
} {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [gridWindow, setGridWindow] = useState<WindowedGridSlice>(UNMEASURED_WINDOW);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || hidden) return;
    let viewportWidth = 0;
    let viewportHeight = 0;
    const publish = () => {
      const next = unboundedGridWindow({
        viewportWidth,
        viewportHeight,
        scrollTop: element.scrollTop,
      });
      setGridWindow((current) => (sameGridSlice(current, next) ? current : next));
    };
    const read = () => {
      viewportWidth = element.clientWidth;
      viewportHeight = element.clientHeight;
      publish();
    };
    read();
    element.addEventListener("scroll", publish, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", publish);
      observer?.disconnect();
    };
  }, [hidden, itemCount]);

  const slice = hidden
    ? { firstIndex: 0, lastIndex: 0, columnCount: gridWindow.columnCount }
    : clampGridSlice(gridWindow, itemCount);

  return {
    scrollerRef,
    slice,
    spacerHeight: contentBrowserGridHeight(itemCount, slice.columnCount),
  };
}
