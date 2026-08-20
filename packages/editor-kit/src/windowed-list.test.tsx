import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { WINDOWED_SLICE_OVERSCAN } from "./windowed-slice";
import {
  PICKER_LIST_MAX_HEIGHT_PX,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  WindowedList,
  pickerListHeightPx,
} from "./windowed-list";

const VIEWPORT = '[data-slot="scroll-area-viewport"]';

function stubScrollViewportHeight(height: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).matches?.(VIEWPORT)) {
        return height;
      }
      return descriptor?.get?.call(this) ?? 0;
    },
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", descriptor);
    }
  };
}

function renderList(itemCount: number, rowHeight: number) {
  return render(
    <ScrollArea>
      <WindowedList itemCount={itemCount} rowHeight={rowHeight}>
        {(index) => (
          <div data-testid={`windowed-row-${index}`}>{index}</div>
        )}
      </WindowedList>
    </ScrollArea>,
  );
}

describe("WindowedList", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts every row when the scroll viewport height is 0", () => {
    const { queryByTestId } = renderList(80, 28);
    expect(queryByTestId("windowed-row-0")).toBeTruthy();
    expect(queryByTestId("windowed-row-79")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-testid^="windowed-row-"]').length,
    ).toBe(80);
  });

  it("mounts only viewport-near rows plus overscan for a 500-row list", () => {
    const restore = stubScrollViewportHeight(280);
    try {
      const { queryByTestId } = renderList(500, 28);
      const mounted = document.querySelectorAll(
        '[data-testid^="windowed-row-"]',
      );
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(40);
      expect(mounted.length).toBeLessThanOrEqual(
        Math.ceil(280 / 28) + WINDOWED_SLICE_OVERSCAN * 2,
      );
      expect(queryByTestId("windowed-row-0")).toBeTruthy();
      expect(queryByTestId("windowed-row-499")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("pickerListHeightPx", () => {
  it("uses one touch row when empty and caps at 16rem", () => {
    expect(pickerListHeightPx(0)).toBe(WINDOWED_LIST_TOUCH_ROW_HEIGHT);
    expect(pickerListHeightPx(2)).toBe(2 * WINDOWED_LIST_TOUCH_ROW_HEIGHT);
    expect(pickerListHeightPx(20)).toBe(PICKER_LIST_MAX_HEIGHT_PX);
  });
});
