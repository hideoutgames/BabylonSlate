import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

/** Only the first rows stagger in; later cards appear as they scroll into view. */
const STAGGERED_ITEMS = 12;

/**
 * A native vertical scroller keeps touch inertia and browser gesture cancellation.
 * `data-scrolling` lets cards ignore the contact that stops momentum.
 */
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
  const touchCount = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);

  const settle = useCallback(() => {
    clearIdleTimer();
    if (touchCount.current) return;
    scroller.current?.removeAttribute("data-scrolling");
  }, [clearIdleTimer]);

  const scheduleSettle = useCallback(() => {
    clearIdleTimer();
    // scrollend owns browsers that support it; this also covers older WebViews.
    idleTimer.current = setTimeout(settle, 150);
  }, [clearIdleTimer, settle]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.addEventListener("scrollend", settle);
    return () => {
      element.removeEventListener("scrollend", settle);
      clearIdleTimer();
    };
  }, [clearIdleTimer, settle]);

  return (
    <div className="homepage-gallery" data-layout={layout}>
      <div
        ref={scroller}
        className="homepage-gallery-scroll"
        role="region"
        aria-label={label}
        tabIndex={items.length ? 0 : -1}
        onScroll={(event) => {
          event.currentTarget.dataset.scrolling = "true";
          scheduleSettle();
        }}
        onTouchStartCapture={(event) => {
          touchCount.current = event.touches.length;
          clearIdleTimer();
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
      >
        {items.length ? (
          <div className="homepage-gallery-grid">
            {items.map((item, index) => (
              <div
                className="homepage-gallery-item"
                key={item.id}
                style={
                  {
                    "--item-index": Math.min(index, STAGGERED_ITEMS),
                  } as CSSProperties
                }
              >
                {item.content}
              </div>
            ))}
          </div>
        ) : (
          empty
        )}
      </div>
    </div>
  );
}
