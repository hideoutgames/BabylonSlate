import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CONTEXT_MENU_MOVE_TOLERANCE_PX } from "@babylonslate/editor-kit";
import { useContentBrowserPaintSelect } from "./use-content-browser-paint-select";
import type { ContentBrowserSelection } from "./content-browser-helpers";

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: {
    pointerId?: number;
    pointerType?: "touch" | "mouse" | "pen";
    clientX?: number;
    clientY?: number;
  } = {},
): void {
  const {
    pointerId = 1,
    pointerType = "touch",
    clientX = 0,
    clientY = 0,
  } = init;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    target.dispatchEvent(event);
  });
}

function PaintHost({
  onPaint,
  onExclusiveClick,
}: {
  onPaint: (selection: ContentBrowserSelection) => void;
  onExclusiveClick?: (id: string) => void;
}) {
  const { gridBind, consumeSelectClick, markMenuOpened, painting } =
    useContentBrowserPaintSelect({ onPaint });
  return (
    <div data-testid="grid" {...gridBind}>
      <span data-testid="painting">{painting ? "yes" : "no"}</span>
      <button
        type="button"
        data-testid="tile-a"
        data-asset-guid="a"
        onClick={() => {
          if (consumeSelectClick()) return;
          onExclusiveClick?.("a");
        }}
      >
        A
      </button>
      <button
        type="button"
        data-testid="tile-b"
        data-asset-guid="b"
        onClick={() => {
          if (consumeSelectClick()) return;
          onExclusiveClick?.("b");
        }}
      >
        B
      </button>
      <button type="button" data-testid="empty">
        empty
      </button>
      <button type="button" data-testid="mark-menu" onClick={() => markMenuOpened()}>
        menu
      </button>
    </div>
  );
}

const ORIGIN = { clientX: 10, clientY: 10 };

describe("useContentBrowserPaintSelect", () => {
  let previousFromPoint: typeof Document.prototype.elementFromPoint;

  beforeEach(() => {
    previousFromPoint = Document.prototype.elementFromPoint;
  });

  afterEach(() => {
    Document.prototype.elementFromPoint = previousFromPoint;
    cleanup();
    vi.restoreAllMocks();
  });

  it("paints every card the pointer crosses after moving past the menu tolerance", () => {
    const onPaint = vi.fn();
    const onExclusiveClick = vi.fn();
    const { getByTestId } = render(
      <PaintHost onPaint={onPaint} onExclusiveClick={onExclusiveClick} />,
    );
    const grid = getByTestId("grid");
    const tileA = getByTestId("tile-a");
    const tileB = getByTestId("tile-b");
    Document.prototype.elementFromPoint = (x) => (x >= 40 ? tileB : tileA);
    const captured: number[] = [];
    Object.defineProperty(grid, "setPointerCapture", {
      configurable: true,
      value: (id: number) => {
        captured.push(id);
      },
    });

    dispatchPointerEvent(tileA, "pointerdown", ORIGIN);
    dispatchPointerEvent(tileA, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
      clientY: ORIGIN.clientY,
    });
    expect(captured).toEqual([1]);
    expect(getByTestId("painting").textContent).toBe("yes");
    expect(onPaint).toHaveBeenCalledTimes(1);
    expect([...onPaint.mock.calls[0]![0].guids]).toEqual(["a"]);

    dispatchPointerEvent(tileA, "pointermove", {
      clientX: 40,
      clientY: ORIGIN.clientY,
    });
    expect([...onPaint.mock.calls.at(-1)![0].guids]).toEqual(["a", "b"]);

    dispatchPointerEvent(tileA, "pointerup", { clientX: 40, clientY: ORIGIN.clientY });
    fireEvent.click(tileA);
    expect(onExclusiveClick).not.toHaveBeenCalled();
  });

  it("does not paint when the pointer stays within the menu tolerance", () => {
    const onPaint = vi.fn();
    const { getByTestId } = render(<PaintHost onPaint={onPaint} />);
    const tileA = getByTestId("tile-a");
    dispatchPointerEvent(tileA, "pointerdown", ORIGIN);
    dispatchPointerEvent(tileA, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX - 1,
      clientY: ORIGIN.clientY,
    });
    dispatchPointerEvent(tileA, "pointerup", ORIGIN);
    expect(onPaint).not.toHaveBeenCalled();
    expect(getByTestId("painting").textContent).toBe("no");
  });

  it("does not paint a drag that starts on empty grid", () => {
    const onPaint = vi.fn();
    const { getByTestId } = render(<PaintHost onPaint={onPaint} />);
    const empty = getByTestId("empty");
    dispatchPointerEvent(empty, "pointerdown", ORIGIN);
    dispatchPointerEvent(empty, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX + 20,
      clientY: ORIGIN.clientY,
    });
    expect(onPaint).not.toHaveBeenCalled();
  });

  it("suppresses the following click after a paint or after a context menu", () => {
    const onPaint = vi.fn();
    const onExclusiveClick = vi.fn();
    const { getByTestId } = render(
      <PaintHost onPaint={onPaint} onExclusiveClick={onExclusiveClick} />,
    );
    const tileA = getByTestId("tile-a");
    Document.prototype.elementFromPoint = () => tileA;

    dispatchPointerEvent(tileA, "pointerdown", ORIGIN);
    dispatchPointerEvent(tileA, "pointermove", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
      clientY: ORIGIN.clientY,
    });
    dispatchPointerEvent(tileA, "pointerup", {
      clientX: ORIGIN.clientX + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
      clientY: ORIGIN.clientY,
    });
    fireEvent.click(tileA);
    expect(onPaint).toHaveBeenCalled();
    expect(onExclusiveClick).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("mark-menu"));
    fireEvent.click(tileA);
    expect(onExclusiveClick).not.toHaveBeenCalled();

    fireEvent.click(tileA);
    expect(onExclusiveClick).toHaveBeenCalledWith("a");
  });

  it("does not let a prior menu suppress a later tap on another card", () => {
    const onPaint = vi.fn();
    const onExclusiveClick = vi.fn();
    const { getByTestId } = render(
      <PaintHost onPaint={onPaint} onExclusiveClick={onExclusiveClick} />,
    );
    fireEvent.click(getByTestId("mark-menu"));
    const tileB = getByTestId("tile-b");
    dispatchPointerEvent(tileB, "pointerdown", { clientX: 40, clientY: 10 });
    dispatchPointerEvent(tileB, "pointerup", { clientX: 40, clientY: 10 });
    fireEvent.click(tileB);
    expect(onExclusiveClick).toHaveBeenCalledWith("b");
  });
});
