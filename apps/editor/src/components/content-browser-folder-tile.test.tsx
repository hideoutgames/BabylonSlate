import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
} from "@babylonslate/editor-kit";
import { ContentBrowserFolderTile } from "./content-browser-folder-tile";

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
  target.dispatchEvent(event);
}

function renderTile(
  overrides: Partial<Parameters<typeof ContentBrowserFolderTile>[0]> = {},
) {
  const onOpen = vi.fn();
  const onSelect = vi.fn();
  const onLongPressMenu = vi.fn();
  const utils = render(
    <ContentBrowserFolderTile
      path="assets/fx"
      name="fx"
      selected={false}
      onOpen={onOpen}
      onSelect={onSelect}
      onLongPressMenu={onLongPressMenu}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onOpen,
    onSelect,
    onLongPressMenu,
    tile: screen.getByTestId("content-folder-assets/fx"),
  };
}

describe("ContentBrowserFolderTile", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens the context menu after a stationary long press", async () => {
    vi.useFakeTimers();
    const { tile, onLongPressMenu } = renderTile();
    dispatchPointerEvent(tile, "pointerdown", { clientX: 5, clientY: 5 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onLongPressMenu).toHaveBeenCalledWith(5, 5);
  });

  it("does not open the context menu when the pointer moves before the delay", async () => {
    vi.useFakeTimers();
    const { tile, onLongPressMenu } = renderTile();
    dispatchPointerEvent(tile, "pointerdown", { clientX: 5, clientY: 5 });
    await act(async () => {
      dispatchPointerEvent(tile, "pointermove", {
        clientX: 5 + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
        clientY: 5,
      });
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onLongPressMenu).not.toHaveBeenCalled();
  });

  it("opens the context menu on right-click", () => {
    const { tile, onLongPressMenu, onSelect } = renderTile();
    const notPrevented = fireEvent.contextMenu(tile, {
      clientX: 12,
      clientY: 18,
    });
    expect(notPrevented).toBe(false);
    expect(onSelect).toHaveBeenCalled();
    expect(onLongPressMenu).toHaveBeenCalledWith(12, 18);
  });

  it("is not an HTML5 drag source", () => {
    const { tile } = renderTile();
    expect(tile.getAttribute("draggable")).not.toBe("true");
  });

  it("uses an uncolored card thumb without a folder type wash", () => {
    const { tile } = renderTile();
    const card = tile.closest('[data-slot="card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.style.backgroundColor).toBe("");
    expect(card?.style.borderColor).toBe("");
    const thumb = tile.querySelector(".aspect-square") as HTMLElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb?.style.backgroundImage).toBe("");
    expect(thumb?.style.backgroundColor).toBe("");
    expect(thumb?.style.boxShadow).toBe("");
    expect(thumb?.innerHTML).not.toContain("--asset-folder");
    const icon = thumb?.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("text-muted-foreground");
  });

  it("does not bubble pointer events to an empty-grid listener", () => {
    const onGridPointerDown = vi.fn();
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    const onLongPressMenu = vi.fn();
    render(
      <div onPointerDown={onGridPointerDown}>
        <ContentBrowserFolderTile
          path="assets/fx"
          name="fx"
          selected={false}
          onOpen={onOpen}
          onSelect={onSelect}
          onLongPressMenu={onLongPressMenu}
        />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("content-folder-assets/fx"), {
      pointerType: "touch",
    });
    expect(onGridPointerDown).not.toHaveBeenCalled();
  });
});
