import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  contentBrowserGridHeight,
  windowedGridSlice,
  type WindowedGridSlice,
} from "./content-browser-grid";

export function useContentBrowserGridWindow(
  itemCount: number,
  hidden: boolean,
): {
  scrollerRef: RefObject<HTMLDivElement | null>;
  slice: WindowedGridSlice;
  spacerHeight: number;
} {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || hidden) return;
    const read = () => {
      setViewportWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
      setScrollTop(element.scrollTop);
    };
    read();
    const onScroll = () => setScrollTop(element.scrollTop);
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [hidden, itemCount]);

  const slice =
    hidden && viewportWidth <= 0 && viewportHeight <= 0
      ? { firstIndex: 0, lastIndex: 0, columnCount: 1 }
      : windowedGridSlice({
          itemCount,
          viewportWidth,
          viewportHeight,
          scrollTop,
        });

  return {
    scrollerRef,
    slice,
    spacerHeight: contentBrowserGridHeight(itemCount, slice.columnCount),
  };
}
