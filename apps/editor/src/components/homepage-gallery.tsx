import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";

/** Native scroll snapping keeps touch inertia and browser gesture cancellation. */
export function HomepageGallery({
  items,
  empty,
  label,
  layout = "large",
}: {
  items: Array<{ id: string; content: ReactNode }>;
  empty?: ReactNode;
  label: string;
  layout?: "large" | "small" | "list";
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  const [rows, setRows] = useState(layout === "list" ? 6 : 1);
  const [width, setWidth] = useState(0);
  const pageSize = layout === "list" ? rows : columns * rows;
  const [page, setPage] = useState(0);
  const [visiblePage, setVisiblePage] = useState(0);
  const [navigationPage, setNavigationPage] = useState(0);
  const requestedPage = useRef<number | null>(null);
  const settledPage = useRef(0);
  const touchCount = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef({ id: items[0]?.id, index: 0 });
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const state = useRef({ items, pageSize, pages });
  state.current = { items, pageSize, pages };
  const itemIds = JSON.stringify(items.map((item) => item.id));

  const clearIdleTimer = useCallback(() => {
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);

  const settle = useCallback(() => {
    clearIdleTimer();
    const element = scroller.current;
    if (!element?.clientWidth || touchCount.current) return;
    // An instant layout realignment may emit scrollend after its anchor is saved.
    if (
      requestedPage.current === null &&
      element.dataset.scrolling !== "true"
    ) {
      return;
    }
    const { items: currentItems, pageSize: size, pages: count } = state.current;
    const next = Math.max(
      0,
      Math.min(count - 1, Math.round(element.scrollLeft / element.clientWidth)),
    );
    requestedPage.current = null;
    settledPage.current = next;
    anchor.current = { id: currentItems[next * size]?.id, index: next * size };
    element.removeAttribute("data-scrolling");
    setPage(next);
    setVisiblePage(next);
    setNavigationPage(next);
  }, [clearIdleTimer]);

  const scheduleSettle = useCallback(() => {
    clearIdleTimer();
    // scrollend owns browsers that support it; this also covers older WebViews.
    idleTimer.current = setTimeout(settle, 150);
  }, [clearIdleTimer, settle]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const resize = () => {
      const width = element.clientWidth;
      if (!width) return;
      setWidth(width);
      setColumns(
        layout === "small"
          ? width >= 1240
            ? 6
            : width >= 900
              ? 5
              : width >= 560
                ? 3
                : 2
          : width >= 1240
            ? 4
            : width >= 900
              ? 3
              : width >= 560
                ? 2
                : 1,
      );
      const height = element.clientHeight;
      setRows(
        layout === "list"
          ? Math.max(1, Math.min(10, Math.floor((height - 32) / 72)))
          : Math.max(
              1,
              Math.min(
                layout === "small" ? 4 : 3,
                Math.floor(
                  (height - 12) / ((layout === "small" ? 170 : 260) + 12),
                ),
              ),
            ),
      );
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [layout]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const currentItems = state.current.items;
    const found = currentItems.findIndex(
      (item) => item.id === anchor.current.id,
    );
    const index =
      found >= 0
        ? found
        : Math.min(anchor.current.index, Math.max(0, currentItems.length - 1));
    const next = Math.floor(index / pageSize);
    clearIdleTimer();
    requestedPage.current = null;
    settledPage.current = next;
    anchor.current = { id: currentItems[index]?.id, index };
    element.removeAttribute("data-scrolling");
    setPage(next);
    setVisiblePage(next);
    setNavigationPage(next);
    element.scrollTo?.({
      left: next * element.clientWidth,
      behavior: "instant",
    });
  }, [pageSize, itemIds, layout, width, clearIdleTimer]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.addEventListener("scrollend", settle);
    return () => {
      element.removeEventListener("scrollend", settle);
      clearIdleTimer();
    };
  }, [clearIdleTimer, settle]);

  const move = (direction: number) => {
    const element = scroller.current;
    if (!element?.clientWidth) return;
    const from =
      requestedPage.current ??
      Math.round(element.scrollLeft / element.clientWidth);
    const target = Math.max(0, Math.min(pages - 1, from + direction));
    const left = target * element.clientWidth;
    requestedPage.current = target;
    setNavigationPage(target);
    const instant = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (instant || Math.abs(element.scrollLeft - left) < 1) {
      element.scrollTo({ left, behavior: "instant" });
      settle();
      return;
    }
    // Card gestures can inspect this immediately, before React renders again.
    element.dataset.scrolling = "true";
    element.scrollTo({ left, behavior: "smooth" });
    scheduleSettle();
  };

  return (
    <div
      className="homepage-gallery"
      data-columns={columns}
      data-layout={layout}
    >
      <div
        ref={scroller}
        className="homepage-pages"
        role="region"
        aria-label={label}
        aria-roledescription="carousel"
        tabIndex={items.length ? 0 : -1}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (!element.clientWidth) return;
          // Layout anchoring and instant moves may dispatch a later scroll event.
          if (
            element.dataset.scrolling !== "true" &&
            Math.abs(
              element.scrollLeft - settledPage.current * element.clientWidth,
            ) < 1
          ) {
            return;
          }
          const nearest = Math.max(
            0,
            Math.min(
              pages - 1,
              Math.round(element.scrollLeft / element.clientWidth),
            ),
          );
          element.dataset.scrolling = "true";
          setVisiblePage(nearest);
          if (requestedPage.current === null) setNavigationPage(nearest);
          scheduleSettle();
        }}
        onTouchStartCapture={(event) => {
          touchCount.current = event.touches.length;
          requestedPage.current = null;
          clearIdleTimer();
          const element = event.currentTarget;
          if (element.clientWidth) {
            setNavigationPage(
              Math.max(
                0,
                Math.min(
                  pages - 1,
                  Math.round(element.scrollLeft / element.clientWidth),
                ),
              ),
            );
          }
        }}
        onTouchEndCapture={(event) => {
          touchCount.current = event.touches.length;
          if (
            !touchCount.current &&
            event.currentTarget.dataset.scrolling === "true"
          ) {
            scheduleSettle();
          }
        }}
        onTouchCancelCapture={() => {
          touchCount.current = 0;
          if (scroller.current?.dataset.scrolling === "true") scheduleSettle();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            move(event.key === "ArrowRight" ? 1 : -1);
          }
        }}
      >
        {items.length
          ? Array.from({ length: pages }, (_, index) => (
              <div
                className="homepage-gallery-page"
                key={index}
                style={{
                  gridTemplateColumns:
                    layout === "list"
                      ? "minmax(0, 1fr)"
                      : `repeat(${columns}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${rows}, minmax(0, ${layout === "large" ? "320px" : "1fr"}))`,
                }}
                role="group"
                aria-label={`Page ${index + 1} of ${pages}`}
                inert={index !== currentPage}
              >
                {Math.abs(index - visiblePage) <= 1 &&
                  items
                    .slice(index * pageSize, (index + 1) * pageSize)
                    .map((item, itemIndex) => (
                      <div
                        className="homepage-gallery-item"
                        key={item.id}
                        style={
                          { "--item-index": itemIndex } as CSSProperties
                        }
                      >
                        {item.content}
                      </div>
                    ))}
              </div>
            ))
          : empty}
      </div>
      <div className="homepage-pagination" data-visible={pages > 1}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous Page"
          disabled={navigationPage === 0}
          onClick={() => move(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <span role="status" aria-live="polite">
          {String(currentPage + 1).padStart(2, "0")}{" "}
          <span>/ {String(pages).padStart(2, "0")}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next Page"
          disabled={navigationPage >= pages - 1}
          onClick={() => move(1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
