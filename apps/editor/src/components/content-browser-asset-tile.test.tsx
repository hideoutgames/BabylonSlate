import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IndexedAsset } from "@babylonslate/assets";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  DRAG_ARM_MS,
} from "@babylonslate/editor-kit";
import { ASSET_DRAG_MIME } from "../lib/content-browser-helpers";
import { ContentBrowserAssetTile } from "./content-browser-asset-tile";

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

function asset(): IndexedAsset {
  return {
    rootId: "project",
    path: "assets/hero.babasset",
    header: {
      guid: "hero-1",
      type: "Texture",
      name: "hero",
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [],
    },
  };
}

function renderTile(
  overrides: Partial<Parameters<typeof ContentBrowserAssetTile>[0]> = {},
) {
  const onOpen = vi.fn();
  const onSelect = vi.fn();
  const onLongPressMenu = vi.fn();
  const onArmedDrag = vi.fn();
  const onDropAsset = vi.fn();
  const onDropPathChange = vi.fn();
  const item = asset();
  const utils = render(
    <div>
      <button type="button" data-folder-path="assets/fx" data-testid="drop-folder">
        fx
      </button>
      <ContentBrowserAssetTile
        asset={item}
        selected={false}
        thumbnailUrl={null}
        onOpen={onOpen}
        onSelect={onSelect}
        onLongPressMenu={onLongPressMenu}
        onArmedDrag={onArmedDrag}
        onDropAsset={onDropAsset}
        onDropPathChange={onDropPathChange}
        {...overrides}
      />
    </div>,
  );
  return {
    ...utils,
    onOpen,
    onSelect,
    onLongPressMenu,
    onArmedDrag,
    onDropAsset,
    onDropPathChange,
    tile: screen.getByTestId("content-item-assets/hero.babasset"),
    folder: screen.getByTestId("drop-folder"),
  };
}

describe("ContentBrowserAssetTile", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not open the context menu while the pointer is still down", async () => {
    vi.useFakeTimers();
    const { tile, onLongPressMenu } = renderTile();
    dispatchPointerEvent(tile, "pointerdown", { clientX: 5, clientY: 5 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onLongPressMenu).not.toHaveBeenCalled();
  });

  it("opens the context menu on release after a stationary long press", async () => {
    vi.useFakeTimers();
    const { tile, onLongPressMenu, onDropAsset } = renderTile();
    dispatchPointerEvent(tile, "pointerdown", { clientX: 5, clientY: 5 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    dispatchPointerEvent(tile, "pointerup", { clientX: 5, clientY: 5 });
    expect(onLongPressMenu).toHaveBeenCalledWith(5, 5);
    expect(onDropAsset).not.toHaveBeenCalled();
  });

  it("drops onto a folder after hold-then-drag", async () => {
    vi.useFakeTimers();
    const { tile, folder, onDropAsset, onLongPressMenu, onArmedDrag } =
      renderTile();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => folder,
    });

    dispatchPointerEvent(tile, "pointerdown", { clientX: 80, clientY: 80 });
    await act(async () => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    expect(onArmedDrag).toHaveBeenCalledWith("hero-1");
    await act(async () => {
      dispatchPointerEvent(tile, "pointermove", { clientX: 10, clientY: 10 });
    });
    dispatchPointerEvent(tile, "pointerup", { clientX: 10, clientY: 10 });
    expect(onDropAsset).toHaveBeenCalledWith("hero-1", "assets/fx");
    expect(onLongPressMenu).not.toHaveBeenCalled();
  });

  it("can drop an asset onto the assets root folder", async () => {
    vi.useFakeTimers();
    const root = document.createElement("button");
    root.setAttribute("data-folder-path", "assets");
    const { tile, onDropAsset } = renderTile();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => root,
    });

    dispatchPointerEvent(tile, "pointerdown", { clientX: 80, clientY: 80 });
    await act(async () => {
      vi.advanceTimersByTime(DRAG_ARM_MS);
    });
    await act(async () => {
      dispatchPointerEvent(tile, "pointermove", { clientX: 4, clientY: 4 });
    });
    dispatchPointerEvent(tile, "pointerup", { clientX: 4, clientY: 4 });
    expect(onDropAsset).toHaveBeenCalledWith("hero-1", "assets");
  });

  it("starts an HTML5 asset drag with the asset MIME payload", () => {
    const { tile } = renderTile();
    const setData = vi.fn();
    fireEvent.dragStart(tile, {
      dataTransfer: { setData, effectAllowed: "copyMove" },
    });
    expect(setData).toHaveBeenCalledWith(
      ASSET_DRAG_MIME,
      expect.stringContaining("hero-1"),
    );
  });
});
