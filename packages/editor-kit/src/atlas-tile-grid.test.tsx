import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
} from "@haptic/assets";
import { AtlasTileGrid } from "./atlas-tile-grid";
import { CONTEXT_MENU_LONG_PRESS_MS } from "./use-context-menu";
import { dispatchPointerEvent } from "./test-support/pointer-events";

afterEach(() => {
  cleanup();
});

function twoTileSet() {
  return ensureTilesetTiles(
    normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tiles: [
        { id: 1, collision: "full" },
        { id: 2, collision: "none" },
      ],
    }),
  );
}

describe("AtlasTileGrid", () => {
  it.each(["pan", "pinch", "wheel"] as const)(
    "does not revisit tile data during %s updates",
    (gesture) => {
      const tileset = ensureTilesetTiles(
        normalizeTilesetPayload({
          atlasWidth: 256,
          atlasHeight: 256,
          tileWidth: 16,
          tileHeight: 16,
        }),
      );
      let tileReads = 0;
      for (const tile of tileset.tiles) {
        const collision = tile.collision;
        Object.defineProperty(tile, "collision", {
          get: () => {
            tileReads++;
            return collision;
          },
        });
      }
      render(
        <AtlasTileGrid
          tileset={tileset}
          imageUrl="blob:atlas"
          selectedId={1}
          onSelect={() => {}}
          panZoom
          data-testid="atlas"
        />,
      );
      const surface = screen.getByTestId("atlas-surface");
      const image = screen.getByTestId("atlas-cell-1").parentElement!;
      surface.getBoundingClientRect = image.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 256, height: 256 }) as DOMRect;
      const originalTransform = image.style.transform;
      if (gesture !== "wheel") {
        act(() => {
          dispatchPointerEvent(surface, "pointerdown", {
            pointerId: 1,
            clientX: 80,
            clientY: 80,
          });
          if (gesture === "pinch")
            dispatchPointerEvent(surface, "pointerdown", {
              pointerId: 2,
              clientX: 120,
              clientY: 80,
            });
        });
      }
      tileReads = 0;

      for (let frame = 1; frame <= 5; frame++) {
        if (gesture === "wheel") {
          fireEvent.wheel(surface, { deltaY: -12, clientX: 100, clientY: 100 });
        } else {
          act(() =>
            dispatchPointerEvent(surface, "pointermove", {
              pointerId: 1,
              clientX: 80 - frame * 10,
              clientY: 80,
            }),
          );
        }
      }

      expect(image.style.transform).not.toBe(originalTransform);
      expect(tileReads).toBe(0);
      expect(screen.getByTestId("atlas-cell-256")).toBeTruthy();
      expect(
        screen.getByTestId("atlas-cell-1").getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it("refreshes cells for selection, tile edits, callbacks, and test IDs", () => {
    let tileset = twoTileSet();
    let selectedId = 1;
    let selectedIds: readonly number[] | undefined = undefined;
    let onSelect = vi.fn();
    let testId = "atlas";
    const grid = () => (
      <AtlasTileGrid
        tileset={tileset}
        imageUrl="blob:atlas"
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={onSelect}
        data-testid={testId}
      />
    );
    const { rerender } = render(grid());

    selectedId = 2;
    rerender(grid());
    expect(
      screen.getByTestId("atlas-cell-1").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByTestId("atlas-cell-2").getAttribute("aria-pressed"),
    ).toBe("true");
    selectedIds = [1, 2];
    rerender(grid());
    expect(
      screen.getByTestId("atlas-cell-1").getAttribute("aria-pressed"),
    ).toBe("true");

    tileset = {
      ...tileset,
      tiles: [
        {
          ...tileset.tiles[0]!,
          collision: {
            kind: "chain",
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          },
        },
        tileset.tiles[1]!,
      ],
    };
    rerender(grid());
    const cell = screen.getByTestId("atlas-cell-1");
    expect(cell.getAttribute("data-collision")).toBe("chain");
    expect(cell.querySelector("polyline")?.getAttribute("points")).toBe(
      "0,1 1,0",
    );

    const previousOnSelect = onSelect;
    onSelect = vi.fn();
    rerender(grid());
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
    expect(previousOnSelect).not.toHaveBeenCalled();
    testId = "renamed-atlas";
    rerender(grid());
    expect(screen.queryByTestId("atlas-cell-1")).toBeNull();
    expect(screen.getByTestId("renamed-atlas-cell-1")).toBeTruthy();
  });
  it.each(["move", "select"] as const)(
    "selects a tile on a captured %s tap",
    (tool) => {
      const onSelect = vi.fn();
      render(
        <AtlasTileGrid
          tileset={twoTileSet()}
          imageUrl={null}
          selectedId={1}
          onSelect={onSelect}
          onSelectionChange={() => {}}
          panZoom
          tool={tool}
          data-testid="atlas"
        />,
      );
      const cell = screen.getByTestId("atlas-cell-2");
      const surface = screen.getByTestId("atlas-surface");
      cell.parentElement!.getBoundingClientRect = () =>
        ({ left: 100, top: 50, width: 64, height: 32 }) as DOMRect;
      act(() => {
        dispatchPointerEvent(cell, "pointerdown", {
          pointerId: 1,
          clientX: 148,
          clientY: 66,
        });
        dispatchPointerEvent(surface, "pointerup", {
          pointerId: 1,
          clientX: 148,
          clientY: 66,
        });
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
      fireEvent.click(cell);
      expect(onSelect).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "selects an atlas rectangle at display scale, reversed=%s",
    (reverse) => {
      const onSelect = vi.fn();
      const onSelectionChange = vi.fn();
      render(
        <AtlasTileGrid
          tileset={ensureTilesetTiles(
            normalizeTilesetPayload({
              atlasWidth: 48,
              atlasHeight: 32,
              tileWidth: 16,
              tileHeight: 16,
            }),
          )}
          imageUrl={null}
          selectedId={1}
          onSelect={onSelect}
          onSelectionChange={onSelectionChange}
          panZoom
          tool="select"
          data-testid="atlas"
        />,
      );
      const surface = screen.getByTestId("atlas-surface");
      const cell = screen.getByTestId("atlas-cell-1");
      cell.parentElement!.getBoundingClientRect = () =>
        ({ left: 100, top: 50, width: 96, height: 64 }) as DOMRect;
      const start = reverse
        ? { clientX: 152, clientY: 102 }
        : { clientX: 104, clientY: 54 };
      const end = reverse
        ? { clientX: 104, clientY: 54 }
        : { clientX: 152, clientY: 102 };
      act(() => {
        dispatchPointerEvent(cell, "pointerdown", { pointerId: 1, ...start });
        dispatchPointerEvent(surface, "pointermove", { pointerId: 1, ...end });
      });
      expect(onSelectionChange).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("atlas-cell-5").getAttribute("aria-pressed"),
      ).toBe("true");
      act(() =>
        dispatchPointerEvent(surface, "pointerup", { pointerId: 1, ...end }),
      );
      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([1, 2, 4, 5]);
      fireEvent.click(cell);
      expect(onSelect).not.toHaveBeenCalled();
      expect(surface.getAttribute("data-pan-x")).toBe("0");
    },
  );

  it("cancels an in-progress selection when a second finger begins a pinch", () => {
    const onSelectionChange = vi.fn();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={2}
        selectedIds={[2]}
        onSelect={() => {}}
        onSelectionChange={onSelectionChange}
        panZoom
        tool="select"
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    const cell = screen.getByTestId("atlas-cell-1");
    cell.parentElement!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 32, height: 16 }) as DOMRect;
    act(() => {
      dispatchPointerEvent(cell, "pointerdown", {
        pointerId: 1,
        clientX: 2,
        clientY: 2,
      });
      dispatchPointerEvent(surface, "pointermove", {
        pointerId: 1,
        clientX: 28,
        clientY: 12,
      });
    });
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", {
        pointerId: 2,
        clientX: 30,
        clientY: 12,
      });
      dispatchPointerEvent(surface, "pointerup", {
        pointerId: 1,
        clientX: 28,
        clientY: 12,
      });
      dispatchPointerEvent(surface, "pointerup", {
        pointerId: 2,
        clientX: 30,
        clientY: 12,
      });
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(cell.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByTestId("atlas-cell-2").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("draws host content inside cells and over the atlas", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={0}
        selectedIds={[]}
        onSelect={() => {}}
        panZoom
        renderCellOverlay={(tileId) => (tileId === 2 ? <span data-testid="badge-2" /> : null)}
        overlay={<div data-testid="ghost" />}
        data-testid="atlas"
      />,
    );
    expect(within(screen.getByTestId("atlas-cell-2")).getByTestId("badge-2")).toBeTruthy();
    expect(screen.getByTestId("atlas-cell-1").childElementCount).toBe(0);
    expect(screen.getByTestId("atlas-cell-1").getAttribute("aria-pressed")).toBe("false");
    // The overlay shares the cells' atlas-pixel space, so it pans and zooms with them.
    expect(screen.getByTestId("ghost").parentElement).toBe(screen.getByTestId("atlas-cell-1").parentElement);
  });

  it("opens a tile's menu on right-click or a still touch hold, and neither selects", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const onMenu = vi.fn();
      render(
        <AtlasTileGrid
          tileset={twoTileSet()}
          imageUrl="blob:atlas"
          selectedId={1}
          onSelect={onSelect}
          panZoom
          onTileContextMenu={onMenu}
          data-testid="atlas"
        />,
      );
      const surface = screen.getByTestId("atlas-surface");
      const cell = screen.getByTestId("atlas-cell-2");
      cell.parentElement!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 32, height: 16 }) as DOMRect;
      fireEvent.contextMenu(cell, { clientX: 24, clientY: 8 });
      expect(onMenu).toHaveBeenLastCalledWith(2, 24, 8);
      act(() => {
        dispatchPointerEvent(cell, "pointerdown", { pointerId: 2, pointerType: "mouse", button: 2, clientX: 24, clientY: 8 });
        dispatchPointerEvent(surface, "pointerup", { pointerId: 2, pointerType: "mouse", button: 2, clientX: 24, clientY: 8 });
      });
      expect(onSelect).not.toHaveBeenCalled();

      act(() => {
        dispatchPointerEvent(cell, "pointerdown", { pointerId: 3, clientX: 20, clientY: 8 });
        vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
      });
      expect(onMenu).toHaveBeenLastCalledWith(2, 20, 8);
      act(() => dispatchPointerEvent(surface, "pointerup", { pointerId: 3, clientX: 20, clientY: 8 }));
      fireEvent.click(cell);
      expect(onSelect).not.toHaveBeenCalled();

      // A press that moves past the tap distance pans and opens nothing.
      onMenu.mockClear();
      act(() => {
        dispatchPointerEvent(cell, "pointerdown", { pointerId: 4, clientX: 20, clientY: 8 });
        dispatchPointerEvent(surface, "pointermove", { pointerId: 4, clientX: 40, clientY: 8 });
        vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
        dispatchPointerEvent(surface, "pointerup", { pointerId: 4, clientX: 40, clientY: 8 });
      });
      expect(onMenu).not.toHaveBeenCalled();
      // A quick tap still selects.
      act(() => {
        dispatchPointerEvent(cell, "pointerdown", { pointerId: 5, clientX: 20, clientY: 8 });
        dispatchPointerEvent(surface, "pointerup", { pointerId: 5, clientX: 20, clientY: 8 });
        vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
      expect(onMenu).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drags from a grabbed tile instead of panning, and pans from any other", () => {
    const drags: Array<[string, number]> = [];
    const onSelect = vi.fn();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={onSelect}
        panZoom
        tileDrag={{
          start: (tileId) => {
            drags.push(["start", tileId]);
            return tileId === 1;
          },
          move: (tileId) => drags.push(["move", tileId]),
        }}
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    const cell = screen.getByTestId("atlas-cell-1");
    cell.parentElement!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 32, height: 16 }) as DOMRect;
    act(() => {
      dispatchPointerEvent(cell, "pointerdown", { pointerId: 1, clientX: 4, clientY: 8 });
      // Still on tile 1: nothing to report.
      dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 14, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 20, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 28, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 1, clientX: 28, clientY: 8 });
    });
    expect(drags).toEqual([["start", 1], ["move", 2]]);
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    expect(onSelect).not.toHaveBeenCalled();
    // A tap on the grabbed tile is still a tap.
    act(() => {
      dispatchPointerEvent(cell, "pointerdown", { pointerId: 2, clientX: 4, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 2, clientX: 4, clientY: 8 });
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
    drags.length = 0;
    act(() => {
      dispatchPointerEvent(screen.getByTestId("atlas-cell-2"), "pointerdown", { pointerId: 3, clientX: 20, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerId: 3, clientX: 60, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 3, clientX: 60, clientY: 8 });
    });
    expect(surface.getAttribute("data-pan-x")).toBe("40");
    expect(drags).toEqual([["start", 2]]);
  });

  it("centres the view on a revealed tile once per token, keeping the zoom", () => {
    const restore = (["clientWidth", "clientHeight"] as const).map(
      (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
    );
    for (const key of ["clientWidth", "clientHeight"] as const) {
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute("data-testid") === "atlas-surface" ? 100 : 0;
        },
      });
    }
    try {
      const grid = (reveal?: { tileId: number; token: number }) => (
        <AtlasTileGrid
          tileset={twoTileSet()}
          imageUrl="blob:atlas"
          selectedId={1}
          onSelect={() => {}}
          panZoom
          reveal={reveal}
          data-testid="atlas"
        />
      );
      const { rerender } = render(grid());
      const surface = screen.getByTestId("atlas-surface");
      // Fit: 0.92 × min(100 / 32, 100 / 16) = 2.875.
      expect(Number(surface.getAttribute("data-zoom"))).toBeCloseTo(2.875);
      rerender(grid({ tileId: 2, token: 1 }));
      // Tile 2's centre (24, 8) lands on the surface centre (50, 50).
      expect(Number(surface.getAttribute("data-pan-x"))).toBeCloseTo(50 - 24 * 2.875);
      expect(Number(surface.getAttribute("data-pan-y"))).toBeCloseTo(50 - 8 * 2.875);
      expect(Number(surface.getAttribute("data-zoom"))).toBeCloseTo(2.875);
      rerender(grid({ tileId: 1, token: 1 }));
      expect(Number(surface.getAttribute("data-pan-x"))).toBeCloseTo(50 - 24 * 2.875);
      rerender(grid({ tileId: 1, token: 2 }));
      expect(Number(surface.getAttribute("data-pan-x"))).toBeCloseTo(50 - 8 * 2.875);
    } finally {
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, key);
      }
    }
  });

  it("renders a cell for every atlas tile and selects on tap", () => {
    const onSelect = vi.fn();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={1}
        onSelect={onSelect}
        data-testid="tileset-preview"
      />,
    );
    expect(screen.getByTestId("tileset-preview-cell-1")).toBeTruthy();
    expect(screen.getByTestId("tileset-preview-cell-2")).toBeTruthy();
    expect(
      screen
        .getByTestId("tileset-preview-cell-1")
        .getAttribute("data-collision"),
    ).toBe("full");
    fireEvent.click(screen.getByTestId("tileset-preview-cell-2"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("shows an empty state when no texture is assigned", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={1}
        onSelect={() => {}}
        emptyLabel="No Texture"
      />,
    );
    expect(screen.getByText("No Texture")).toBeTruthy();
  });

  it("zooms the atlas surface from the wheel", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    // React's wheel listener is passive and cannot cancel the page scroll;
    // fireEvent returns false only when a listener cancelled the event.
    expect(fireEvent.wheel(surface, { deltaY: -120, clientX: 10, clientY: 10 })).toBe(false);
    expect(Number(surface.getAttribute("data-zoom") ?? "1")).toBeGreaterThan(1);
  });

  it("keeps every wheel step that arrives before the atlas re-renders", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    const zoom = Number(surface.getAttribute("data-zoom"));
    const panX = Number(surface.getAttribute("data-pan-x"));
    act(() => {
      for (let step = 0; step < 2; step++) {
        surface.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -120, clientX: 10, clientY: 10, bubbles: true, cancelable: true }),
        );
      }
    });
    // Two notches double the zoom twice, about the pointer.
    expect(Number(surface.getAttribute("data-zoom"))).toBeCloseTo(zoom * 4);
    expect(Number(surface.getAttribute("data-pan-x"))).toBeCloseTo(10 - (10 - panX) * 4);
  });

  it("leaves the wheel to the page when the atlas does not pan and zoom", () => {
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        data-testid="atlas"
      />,
    );
    expect(fireEvent.wheel(screen.getByTestId("atlas-surface"), { deltaY: -120 })).toBe(true);
  });

  it("refits on resize until the user zooms, then keeps their view", () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let size = { width: 64, height: 32 };
    const sizeOf = (key: "width" | "height") => ({
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === "atlas-surface" ? size[key] : 0;
      },
    });
    const restoreWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const restoreHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", sizeOf("width"));
    Object.defineProperty(HTMLElement.prototype, "clientHeight", sizeOf("height"));
    try {
      render(
        <AtlasTileGrid
          tileset={twoTileSet()}
          imageUrl="blob:atlas"
          selectedId={1}
          onSelect={() => {}}
          panZoom
          data-testid="atlas"
        />,
      );
      const surface = screen.getByTestId("atlas-surface");
      const zoomOf = () => Number(surface.getAttribute("data-zoom"));
      const resize = (width: number, height: number) => {
        size = { width, height };
        act(() => callbacks.forEach((callback) => callback()));
      };
      expect(zoomOf()).toBeCloseTo(1.84);
      resize(128, 64);
      expect(zoomOf()).toBeCloseTo(3.68);

      fireEvent.wheel(surface, { deltaY: -120, clientX: 10, clientY: 10 });
      expect(zoomOf()).toBeCloseTo(7.36);
      resize(64, 32);
      expect(zoomOf()).toBeCloseTo(7.36);
    } finally {
      for (const [key, descriptor] of [
        ["clientWidth", restoreWidth],
        ["clientHeight", restoreHeight],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, key);
      }
      vi.unstubAllGlobals();
    }
  });

  it("pans the atlas when two fingers translate without changing spread", async () => {
    HTMLElement.prototype.setPointerCapture = () => {
      throw new DOMException("No active pointer with the given id is found.");
    };
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    surface.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 2,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 2,
      clientX: 160,
      clientY: 80,
    });
    await waitFor(() => {
      expect(Number(surface.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
    expect(Number(surface.getAttribute("data-zoom") ?? "1")).toBe(1);
  });

  it("defaults to Move and pans with one finger", async () => {
    HTMLElement.prototype.setPointerCapture = () => {
      throw new DOMException("No active pointer with the given id is found.");
    };
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    surface.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 256,
        bottom: 256,
        width: 256,
        height: 256,
        toJSON: () => {},
      }) as DOMRect;
    expect(surface.getAttribute("data-tool")).toBe("move");
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    await waitFor(() => {
      expect(Number(surface.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
  });

  it("selects a cell on a Move tap and ignores a drag", () => {
    const onSelect = vi.fn();
    HTMLElement.prototype.setPointerCapture = () => {};
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={onSelect}
        panZoom
        data-testid="atlas"
      />,
    );
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).toHaveBeenCalledWith(2);
    onSelect.mockClear();
    const surface = screen.getByTestId("atlas-surface");
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 80,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    dispatchPointerEvent(surface, "pointerup", {
      pointerId: 1,
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("atlas-cell-2"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
  });
});
