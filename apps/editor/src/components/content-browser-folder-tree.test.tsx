import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FolderNode } from "@babylonslate/assets";
import { ContentBrowserFolderTree } from "./content-browser-folder-tree";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
} from "@babylonslate/editor-kit";

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

const tree: FolderNode = {
  name: "assets",
  path: "assets",
  assets: [],
  children: [
    {
      name: "fx",
      path: "assets/fx",
      assets: [],
      children: [],
    },
  ],
};

function renderTree(
  overrides: Partial<Parameters<typeof ContentBrowserFolderTree>[0]> = {},
) {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const utils = render(
    <ContentBrowserFolderTree
      node={tree}
      selectedPath="assets"
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onSelect,
    onContextMenu,
    root: screen.getByTestId("folder-node-assets"),
    fx: screen.getByTestId("folder-node-assets/fx"),
  };
}

describe("ContentBrowserFolderTree", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not make folder rows HTML5-draggable", () => {
    const { root, fx } = renderTree();
    expect(root.getAttribute("draggable")).not.toBe("true");
    expect(fx.getAttribute("draggable")).not.toBe("true");
  });

  it("opens a nested folder context menu after a stationary long press", async () => {
    vi.useFakeTimers();
    const { fx, onContextMenu, onSelect } = renderTree();
    dispatchPointerEvent(fx, "pointerdown", { clientX: 12, clientY: 20 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onSelect).toHaveBeenCalledWith("assets/fx");
    expect(onContextMenu).toHaveBeenCalledWith("assets/fx", 12, 20);
  });

  it("opens a nested folder context menu on right-click", () => {
    const { fx, onContextMenu, onSelect } = renderTree();
    const notPrevented = fireEvent.contextMenu(fx, {
      clientX: 8,
      clientY: 16,
    });
    expect(notPrevented).toBe(false);
    expect(onSelect).toHaveBeenCalledWith("assets/fx");
    expect(onContextMenu).toHaveBeenCalledWith("assets/fx", 8, 16);
  });

  it("does not open a context menu on the assets root", async () => {
    vi.useFakeTimers();
    const { root, onContextMenu } = renderTree();
    dispatchPointerEvent(root, "pointerdown", { clientX: 8, clientY: 8 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    fireEvent.contextMenu(root, { clientX: 8, clientY: 8 });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("does not open a folder menu when the pointer moves before the delay", async () => {
    vi.useFakeTimers();
    const { fx, onContextMenu } = renderTree();
    dispatchPointerEvent(fx, "pointerdown", { clientX: 10, clientY: 10 });
    await act(async () => {
      dispatchPointerEvent(fx, "pointermove", {
        clientX: 10 + CONTEXT_MENU_MOVE_TOLERANCE_PX + 4,
        clientY: 10,
      });
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
