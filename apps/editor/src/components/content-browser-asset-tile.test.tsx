import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IndexedAsset } from "@babylonslate/assets";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  resolveTypeVisual,
} from "@babylonslate/editor-kit";
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
  const item = asset();
  const utils = render(
    <ContentBrowserAssetTile
      asset={item}
      selected={false}
      thumbnailUrl={null}
      typeVisual={resolveTypeVisual({ assetType: item.header.type })}
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
    tile: screen.getByTestId("content-item-assets/hero.babasset"),
  };
}

describe("ContentBrowserAssetTile", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens the context menu after a stationary long press while the pointer is down", async () => {
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
    const setData = vi.fn();
    fireEvent.dragStart(tile, {
      dataTransfer: { setData, effectAllowed: "copyMove" },
    });
    expect(setData).not.toHaveBeenCalled();
  });

  it("renders a type-colored glyph when there is no thumbnail", () => {
    renderTile();
    const glyph = screen.getByTestId("content-item-type-icon-hero-1");
    expect(glyph.getAttribute("data-type-icon")).toBe("Texture");
    expect(glyph.getAttribute("stroke")).toBe("var(--asset-texture)");
  });

  it("keeps the type glyph compact instead of filling the thumb", () => {
    renderTile();
    const glyph = screen.getByTestId("content-item-type-icon-hero-1");
    const className = glyph.getAttribute("class") ?? "";
    expect(className).toContain("size-10");
    expect(className).not.toContain("size-full");
    expect(className).not.toContain("p-4");
    expect(glyph.getAttribute("width")).toBe("40");
    expect(glyph.getAttribute("height")).toBe("40");
    expect(glyph.getAttribute("stroke-width")).toBe("1.2");
  });

  it("renders the UserInterface tile with the panel glyph and graph stroke color", () => {
    const ui: IndexedAsset = {
      ...asset(),
      path: "assets/hud.babasset",
      header: {
        ...asset().header,
        guid: "hud-1",
        type: "UserInterface",
        name: "HUD",
      },
    };
    render(
      <ContentBrowserAssetTile
        asset={ui}
        selected={false}
        thumbnailUrl={null}
        typeVisual={resolveTypeVisual({ assetType: "UserInterface" })}
        onOpen={vi.fn()}
        onSelect={vi.fn()}
        onLongPressMenu={vi.fn()}
      />,
    );
    const glyph = screen.getByTestId("content-item-type-icon-hud-1");
    expect(glyph.getAttribute("data-type-icon")).toBe("UserInterface");
    expect(glyph.getAttribute("stroke")).toBe("var(--asset-graph)");
    expect(glyph.getAttribute("stroke-width")).toBe("1.2");
  });

  it("outlines the thumb well, leaving the card and text panel on card chrome", () => {
    const { tile } = renderTile();
    const card = tile.closest('[data-slot="card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.style.backgroundColor).toBe("");
    expect(card?.style.borderColor).toBe("");
    const glyph = screen.getByTestId("content-item-type-icon-hero-1");
    const thumb = glyph.parentElement as HTMLElement;
    expect(thumb.style.backgroundImage).toBe("");
    expect(thumb.style.border).toBe("2px solid var(--asset-texture)");
    expect(thumb.style.borderTopLeftRadius).toBe("calc(var(--radius-xl) - 2px)");
    expect(thumb.style.borderTopRightRadius).toBe("calc(var(--radius-xl) - 2px)");
    expect(thumb.style.boxShadow).toBe("");
    expect(thumb.className).toContain("bg-card");
    const well = thumb.parentElement as HTMLElement;
    expect(well.className).toContain("rounded-t-xl");
    expect(well.className).toContain("overflow-hidden");
    expect(well.className).toContain("p-0.5");
  });
});
