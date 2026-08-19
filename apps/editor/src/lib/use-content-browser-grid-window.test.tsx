import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
});
