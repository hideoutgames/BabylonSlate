import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useContentBrowserGridWindow } from "./use-content-browser-grid-window";
import {
  CONTENT_BROWSER_GRID_GAP_PX,
  CONTENT_BROWSER_GRID_PAD_PX,
  CONTENT_BROWSER_TILE_HEIGHT_PX,
  CONTENT_BROWSER_TILE_WIDTH_PX,
} from "./content-browser-grid";

afterEach(() => {
  cleanup();
});

const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);
const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);

function stubGridSize(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      if (
        (this as HTMLElement).getAttribute?.("data-testid") ===
        "content-browser-asset-grid"
      ) {
        return width;
      }
      return clientWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (
        (this as HTMLElement).getAttribute?.("data-testid") ===
        "content-browser-asset-grid"
      ) {
        return height;
      }
      return clientHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
}

afterEach(() => {
  if (clientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      clientHeightDescriptor,
    );
  }
});

function GridHarness({
  count,
  hidden = false,
}: {
  count: number;
  hidden?: boolean;
}) {
  const { scrollerRef, slice } = useContentBrowserGridWindow(count, hidden);
  const [mounted, setMounted] = useState(0);
  useLayoutEffect(() => {
    setMounted(slice.lastIndex - slice.firstIndex);
  }, [slice.firstIndex, slice.lastIndex]);
  return (
    <div ref={scrollerRef} data-testid="content-browser-asset-grid">
      <span data-testid="mounted-count">{mounted}</span>
      {Array.from({ length: slice.lastIndex - slice.firstIndex }, (_, offset) => {
        const index = slice.firstIndex + offset;
        return (
          <div key={index} data-testid={`content-item-assets/tex-${index}.babasset`} />
        );
      })}
    </div>
  );
}

describe("useContentBrowserGridWindow", () => {
  it("mounts every tile when the grid viewport is 0", () => {
    render(<GridHarness count={80} />);
    expect(
      document.querySelectorAll('[data-testid^="content-item-"]').length,
    ).toBe(80);
  });

  it("mounts only viewport-near tiles for a large folder", () => {
    stubGridSize(
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
        CONTENT_BROWSER_TILE_WIDTH_PX * 4 +
        CONTENT_BROWSER_GRID_GAP_PX * 3,
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
        CONTENT_BROWSER_TILE_HEIGHT_PX * 2 +
        CONTENT_BROWSER_GRID_GAP_PX,
    );
    render(<GridHarness count={300} />);
    const mounted = document.querySelectorAll(
      '[data-testid^="content-item-"]',
    ).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(80);
    expect(
      document.querySelector('[data-testid="content-item-assets/tex-0.babasset"]'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-testid="content-item-assets/tex-299.babasset"]',
      ),
    ).toBeNull();
  });

  // Four 144px columns and two 196px rows visible; rows are 204px apart.
  const FOUR_COLUMNS_WIDE =
    CONTENT_BROWSER_GRID_PAD_PX * 2 +
    CONTENT_BROWSER_TILE_WIDTH_PX * 4 +
    CONTENT_BROWSER_GRID_GAP_PX * 3;
  const TWO_ROWS_HIGH =
    CONTENT_BROWSER_GRID_PAD_PX * 2 +
    CONTENT_BROWSER_TILE_HEIGHT_PX * 2 +
    CONTENT_BROWSER_GRID_GAP_PX;

  function mountedRange(): [number, number] {
    const indices = [
      ...document.querySelectorAll('[data-testid^="content-item-"]'),
    ].map((tile) =>
      Number(/tex-(\d+)\./.exec(tile.getAttribute("data-testid") ?? "")![1]),
    );
    return [Math.min(...indices), Math.max(...indices)];
  }

  function scrollGridTo(scrollTop: number) {
    const grid = screen.getByTestId("content-browser-asset-grid");
    grid.scrollTop = scrollTop;
    fireEvent.scroll(grid);
  }

  it("moves the mounted tiles only when scrolling crosses a row boundary", () => {
    stubGridSize(FOUR_COLUMNS_WIDE, TWO_ROWS_HIGH);
    render(<GridHarness count={300} />);
    // Rows 0-2 are in view plus four overscan rows below.
    expect(mountedRange()).toEqual([0, 27]);

    scrollGridTo(150);
    expect(mountedRange()).toEqual([0, 27]);

    // The viewport bottom enters the fourth row.
    scrollGridTo(200);
    expect(mountedRange()).toEqual([0, 31]);

    // Row 5 is at the top: one overscan row above leaves row 0 behind.
    scrollGridTo(1100);
    expect(mountedRange()).toEqual([4, 47]);

    scrollGridTo(0);
    expect(mountedRange()).toEqual([0, 27]);
  });

  it("re-windows as soon as a resize changes the column count", () => {
    let notifyResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      stubGridSize(FOUR_COLUMNS_WIDE, TWO_ROWS_HIGH);
      render(<GridHarness count={300} />);
      expect(mountedRange()).toEqual([0, 27]);

      stubGridSize(
        CONTENT_BROWSER_GRID_PAD_PX * 2 +
          CONTENT_BROWSER_TILE_WIDTH_PX * 2 +
          CONTENT_BROWSER_GRID_GAP_PX,
        TWO_ROWS_HIGH,
      );
      act(() => notifyResize());
      expect(mountedRange()).toEqual([0, 13]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
