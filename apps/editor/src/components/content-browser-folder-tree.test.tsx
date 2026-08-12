import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FolderNode } from "@babylonslate/assets";
import {
  ASSET_DRAG_MIME,
  FOLDER_DRAG_MIME,
} from "../lib/content-browser-helpers";
import { ContentBrowserFolderTree } from "./content-browser-folder-tree";
import { CONTEXT_MENU_LONG_PRESS_MS, DRAG_ARM_MS } from "@babylonslate/editor-kit";

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
  const onRequestDelete = vi.fn();
  const onDropAsset = vi.fn();
  const onDropFolder = vi.fn();
  const onDropPathChange = vi.fn();
  const utils = render(
    <ContentBrowserFolderTree
      node={tree}
      selectedPath="assets"
      dropPath={null}
      onSelect={onSelect}
      onRequestDelete={onRequestDelete}
      onDropAsset={onDropAsset}
      onDropFolder={onDropFolder}
      onDropPathChange={onDropPathChange}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onSelect,
    onRequestDelete,
    onDropAsset,
    onDropFolder,
    onDropPathChange,
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

  it("does not make the assets root draggable", () => {
    const { root, fx } = renderTree();
    expect(root.getAttribute("draggable")).toBe("false");
    expect(fx.getAttribute("draggable")).toBe("true");
  });

  it("moves an asset onto the assets root via HTML5 drop", () => {
    const { root, onDropAsset } = renderTree();
    fireEvent.drop(root, {
      dataTransfer: {
        getData: (type: string) =>
          type === ASSET_DRAG_MIME ? JSON.stringify({ guid: "tex-1" }) : "",
        types: [ASSET_DRAG_MIME],
      },
    });
    expect(onDropAsset).toHaveBeenCalledWith("tex-1", "assets");
  });

  it("does not start a folder move from the assets root on hold-drag", async () => {
    vi.useFakeTimers();
    const { root, onDropFolder } = renderTree();
    dispatchPointerEvent(root, "pointerdown", { clientX: 8, clientY: 8 });
    await act(async () => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    await act(async () => {
      dispatchPointerEvent(root, "pointermove", { clientX: 40, clientY: 40 });
    });
    dispatchPointerEvent(root, "pointerup", { clientX: 40, clientY: 40 });
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  it("reparents a nested folder onto assets after hold-then-drag", async () => {
    vi.useFakeTimers();
    const { root, fx, onDropFolder } = renderTree();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => root,
    });

    dispatchPointerEvent(fx, "pointerdown", { clientX: 10, clientY: 50 });
    await act(async () => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    await act(async () => {
      dispatchPointerEvent(fx, "pointermove", { clientX: 10, clientY: 12 });
    });
    dispatchPointerEvent(fx, "pointerup", { clientX: 10, clientY: 12 });
    expect(onDropFolder).toHaveBeenCalledWith("assets/fx", "assets");
  });

  it("does not open a folder menu while the pointer is still down", async () => {
    vi.useFakeTimers();
    const { fx, onRequestDelete } = renderTree();
    dispatchPointerEvent(fx, "pointerdown", { clientX: 12, clientY: 20 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onRequestDelete).not.toHaveBeenCalled();
    dispatchPointerEvent(fx, "pointerup", { clientX: 12, clientY: 20 });
    expect(onRequestDelete).toHaveBeenCalledWith("assets/fx");
  });

  it("highlights a drop target from HTML5 dragover", () => {
    const { fx, onDropPathChange } = renderTree();
    fireEvent.dragOver(fx, {
      dataTransfer: {
        types: [FOLDER_DRAG_MIME],
        dropEffect: "move",
      },
    });
    expect(onDropPathChange).toHaveBeenCalledWith("assets/fx");
  });

  it("prevents HTML5 drag from the assets root", () => {
    const { root } = renderTree();
    const prevented = !fireEvent.dragStart(root, {
      dataTransfer: { setData: vi.fn(), effectAllowed: "move" },
    });
    expect(prevented).toBe(true);
  });
});
