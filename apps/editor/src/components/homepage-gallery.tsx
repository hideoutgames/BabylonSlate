import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const [listRows, setListRows] = useState(6);
  const rows = layout === "list" ? listRows : layout === "small" ? 2 : 1;
  const pageSize = layout === "list" ? rows : columns * rows;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pages - 1);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const resize = () => {
      const width = element.clientWidth;
      if (!width) return;
      setColumns(width >= 940 ? 3 : width >= 600 ? 2 : 1);
      setListRows(
        Math.max(1, Math.min(10, Math.floor((element.clientHeight - 32) / 72))),
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
  }, []);

  useEffect(() => {
    setPage(0);
    scroller.current?.scrollTo?.({ left: 0, behavior: "instant" });
  }, [pageSize, items.length, layout]);

  const move = (next: number) => {
    const target = Math.max(0, Math.min(pages - 1, next));
    scroller.current?.scrollTo({
      left: target * scroller.current.clientWidth,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
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
          if (element.clientWidth)
            setPage(Math.round(element.scrollLeft / element.clientWidth));
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            move(currentPage + (event.key === "ArrowRight" ? 1 : -1));
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
                      : `repeat(${Math.min(columns, items.length - index * pageSize)}, minmax(0, 380px))`,
                  gridTemplateRows:
                    layout === "large"
                      ? undefined
                      : `repeat(${rows}, minmax(0, 1fr))`,
                  justifyContent: "center",
                }}
                role="group"
                aria-label={`Page ${index + 1} of ${pages}`}
                inert={index !== currentPage}
              >
                {Math.abs(index - currentPage) <= 1 &&
                  items
                    .slice(index * pageSize, (index + 1) * pageSize)
                    .map((item) => (
                      <div className="homepage-gallery-item" key={item.id}>
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
          size="touch-icon"
          aria-label="Previous Page"
          disabled={currentPage === 0}
          onClick={() => move(currentPage - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <span role="status" aria-live="polite">
          {String(currentPage + 1).padStart(2, "0")}{" "}
          <span>/ {String(pages).padStart(2, "0")}</span>
        </span>
        <Button
          variant="ghost"
          size="touch-icon"
          aria-label="Next Page"
          disabled={currentPage >= pages - 1}
          onClick={() => move(currentPage + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
