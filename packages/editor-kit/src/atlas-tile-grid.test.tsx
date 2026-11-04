import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
} from "@haptic/assets";
import { createRef } from "react";
import { AtlasTileGrid, type AtlasTileGridHandle } from "./atlas-tile-grid";
import { dispatchPointerEvent } from "./test-support/pointer-events";

const restorers: Array<() => void> = [];

afterEach(() => {
  cleanup();
  while (restorers.length) restorers.pop()!();
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

/** A 2048 × 2048 sheet of 16 px tiles: 16,384 tiles. */
function largeSheet() {
  return ensureTilesetTiles(normalizeTilesetPayload({ atlasWidth: 2048, atlasHeight: 2048, tileWidth: 16, tileHeight: 16 }));
}

/** jsdom lays nothing out: give the grid's surface a size, so it fits the atlas and draws. */
function sizeSurface(width: number, height: number) {
  for (const key of ["clientWidth", "clientHeight"] as const) {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.getAttribute("data-testid")?.endsWith("-surface")) return 0;
        return key === "clientWidth" ? width : height;
      },
    });
    restorers.push(() => {
      if (previous) Object.defineProperty(HTMLElement.prototype, key, previous);
      else Reflect.deleteProperty(HTMLElement.prototype, key);
    });
  }
}

/** Canvas contexts that record each call with the styles it drew in; `frames()` keeps only each canvas's latest draw. */
function recordCanvas() {
  const contexts = new Map<HTMLCanvasElement, Array<{ op: string; args: unknown[]; stroke: unknown; fill: unknown }>>();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    const calls: Array<{ op: string; args: unknown[]; stroke: unknown; fill: unknown }> = [];
    contexts.set(this, calls);
    const ctx: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1 };
    for (const op of ["setTransform", "clearRect", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "stroke", "arc", "fill", "save", "restore", "rect", "clip", "closePath", "drawImage"]) {
      ctx[op] = (...args: unknown[]) => {
        // A draw starts with its transform: keep only the latest one.
        if (op === "setTransform") calls.length = 0;
        calls.push({ op, args, stroke: ctx.strokeStyle, fill: ctx.fillStyle });
      };
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  restorers.push(() => {
    HTMLCanvasElement.prototype.getContext = original;
  });
  return (canvas: HTMLElement) => contexts.get(canvas as HTMLCanvasElement) ?? [];
}

/** Put the atlas image at a client rect, as layout would. */
function placeImage(testId: string, rect: { left: number; top: number; width: number; height: number }) {
  screen.getByTestId(`${testId}-image`).getBoundingClientRect = () => rect as DOMRect;
}

describe("AtlasTileGrid", () => {
  it("keeps the same few elements for any tile count and draws only the cells in view on each pan", () => {
    sizeSurface(256, 256);
    const drawn = recordCanvas();
    const tileset = largeSheet();
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
    const handle = createRef<AtlasTileGridHandle>();
    const { container } = render(
      <AtlasTileGrid ref={handle} tileset={tileset} imageUrl="blob:atlas" selectedId={1} onSelect={() => {}} panZoom data-testid="atlas" />,
    );
    // 16,384 tiles, one focus cell: the grid is a handful of elements, not one per tile.
    expect(container.querySelectorAll("*").length).toBeLessThan(12);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    act(() => handle.current!.zoomBy(8));
    const surface = screen.getByTestId("atlas-surface");
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 256 }) as DOMRect;
    tileReads = 0;
    act(() => dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, clientX: 200, clientY: 200 }));
    for (let frame = 1; frame <= 5; frame++) {
      act(() => dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 200 - frame * 20, clientY: 200 }));
    }
    // At about 15 px a cell, a 256 px surface shows under 20 × 20 cells; each draw reads each twice.
    const borders = drawn(screen.getByTestId("atlas-canvas")).filter((call) => call.op === "rect").length;
    expect(borders).toBeGreaterThan(200);
    expect(borders).toBeLessThan(400);
    expect(tileReads).toBeLessThan(5 * 2 * 400);
    expect(Number(surface.getAttribute("data-pan-x"))).not.toBeCloseTo(0);
  });

  it("hit-tests a tap by column and row, moves the focus cell there and selects once", () => {
    const tileset = largeSheet();
    const onSelect = vi.fn();
    render(<AtlasTileGrid tileset={tileset} imageUrl="blob:atlas" selectedId={1} onSelect={onSelect} panZoom data-testid="atlas" />);
    // The 2048 px atlas shown at 1024 px: tile (column 100, row 70) spans 800-808 × 560-568.
    placeImage("atlas", { left: 0, top: 0, width: 1024, height: 1024 });
    const surface = screen.getByTestId("atlas-surface");
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, clientX: 804, clientY: 564 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 1, clientX: 804, clientY: 564 });
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(70 * 128 + 100 + 1);
    const cell = screen.getByTestId(`atlas-cell-${70 * 128 + 101}`);
    // The tap's click lands on the focus cell, and is not a second selection.
    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(cell.style.left).toBe("1600px");
    expect(cell.style.top).toBe("1120px");
  });

  it("moves the one focusable cell with the arrow keys, brings it into view and selects it with Enter", () => {
    sizeSurface(100, 100);
    const onSelect = vi.fn();
    const tileset = largeSheet();
    const handle = createRef<AtlasTileGridHandle>();
    render(<AtlasTileGrid ref={handle} tileset={tileset} imageUrl="blob:atlas" selectedId={130} onSelect={onSelect} panZoom data-testid="atlas" />);
    act(() => handle.current!.zoomBy(30));
    const surface = screen.getByTestId("atlas-surface");
    const panX = () => Number(surface.getAttribute("data-pan-x"));
    // The focus starts on the selection: tile 130 is column 1 of row 1.
    let cell = screen.getByTestId("atlas-cell-130");
    expect(cell.getAttribute("aria-label")).toBe("Tile 130");
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    expect(cell.tabIndex).toBe(0);
    fireEvent.keyDown(cell, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("atlas-cell-258"), { key: "ArrowRight" });
    cell = screen.getByTestId("atlas-cell-259");
    expect(cell.getAttribute("aria-pressed")).toBe("false");
    // The focus cell is the same element, so keyboard focus stays on it as it moves.
    cell.focus();
    const before = panX();
    for (let step = 0; step < 6; step++) fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("atlas-cell-265");
    // The view followed the focus off the right edge.
    expect(panX()).toBeLessThan(before);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("atlas-cell-257");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("atlas-cell-257");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.click(document.activeElement!);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(384);
  });

  it("draws selection rings, collision and the hovered tile for the latest props, and calls the latest handler", () => {
    sizeSurface(64, 32);
    const drawn = recordCanvas();
    let tileset = twoTileSet();
    let selectedId = 1;
    let selectedIds: readonly number[] | undefined = undefined;
    let onSelect = vi.fn();
    let testId = "atlas";
    const grid = () => (
      <AtlasTileGrid tileset={tileset} imageUrl="blob:atlas" selectedId={selectedId} selectedIds={selectedIds} onSelect={onSelect} panZoom data-testid={testId} />
    );
    const { rerender } = render(grid());
    const rings = () => drawn(screen.getByTestId(`${testId}-canvas`))
      .filter((call) => call.op === "strokeRect" && call.stroke === "#f59e0b")
      .map((call) => call.args[0] as number);
    // Fit: 0.92 × min(64 / 32, 32 / 16) = 1.84, centred: tile 1 starts at 2.56, tile 2 at 32.
    expect(rings().map(Math.round)).toEqual([4]);
    selectedId = 2;
    rerender(grid());
    expect(rings().map(Math.round)).toEqual([33]);
    expect(screen.getByTestId("atlas-cell-2").getAttribute("aria-pressed")).toBe("true");
    selectedIds = [1, 2];
    rerender(grid());
    expect(rings()).toHaveLength(2);
    expect(screen.getByTestId("atlas-cell-1").getAttribute("aria-pressed")).toBe("true");

    tileset = { ...tileset, tiles: [{ ...tileset.tiles[0]!, collision: { kind: "chain", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, tileset.tiles[1]!] };
    rerender(grid());
    const calls = drawn(screen.getByTestId("atlas-canvas"));
    // The Full tint is gone and tile 1 draws its chain instead.
    expect(calls.some((call) => call.op === "fillRect" && call.fill === "#3b82f6")).toBe(false);
    expect(calls.filter((call) => call.op === "lineTo")).toHaveLength(1);

    const previousOnSelect = onSelect;
    onSelect = vi.fn();
    rerender(grid());
    fireEvent.click(screen.getByTestId("atlas-cell-1"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(previousOnSelect).not.toHaveBeenCalled();
    testId = "renamed-atlas";
    rerender(grid());
    expect(screen.queryByTestId("atlas-cell-1")).toBeNull();
    expect(screen.getByTestId("renamed-atlas-cell-1")).toBeTruthy();

    // A hovering mouse highlights its tile.
    placeImage("renamed-atlas", { left: 0, top: 0, width: 32, height: 16 });
    act(() => dispatchPointerEvent(screen.getByTestId("renamed-atlas-surface"), "pointermove", { pointerType: "mouse", clientX: 20, clientY: 8 }));
    expect(drawn(screen.getByTestId("renamed-atlas-canvas")).some((call) => call.op === "fillRect" && call.fill === "#fafafa")).toBe(true);
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
      const surface = screen.getByTestId("atlas-surface");
      placeImage("atlas", { left: 100, top: 50, width: 64, height: 32 });
      act(() => {
        dispatchPointerEvent(surface, "pointerdown", {
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
      fireEvent.click(screen.getByTestId("atlas-cell-2"));
      expect(onSelect).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "selects an atlas rectangle at display scale, reversed=%s",
    (reverse) => {
      sizeSurface(96, 64);
      const drawn = recordCanvas();
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
      placeImage("atlas", { left: 100, top: 50, width: 96, height: 64 });
      const start = reverse
        ? { clientX: 152, clientY: 102 }
        : { clientX: 104, clientY: 54 };
      const end = reverse
        ? { clientX: 104, clientY: 54 }
        : { clientX: 152, clientY: 102 };
      act(() => {
        dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, ...start });
        dispatchPointerEvent(surface, "pointermove", { pointerId: 1, ...end });
      });
      expect(onSelectionChange).not.toHaveBeenCalled();
      // The rectangle's four tiles are ringed while it is dragged.
      const rings = drawn(screen.getByTestId("atlas-canvas")).filter((call) => call.op === "strokeRect" && call.stroke === "#f59e0b");
      expect(rings).toHaveLength(4);
      act(() =>
        dispatchPointerEvent(surface, "pointerup", { pointerId: 1, ...end }),
      );
      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([1, 2, 4, 5]);
      fireEvent.click(screen.getByTestId("atlas-cell-1"));
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("cancels an in-progress selection when a second finger begins a pinch", () => {
    sizeSurface(64, 32);
    const drawn = recordCanvas();
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
    placeImage("atlas", { left: 0, top: 0, width: 32, height: 16 });
    const rings = () => drawn(screen.getByTestId("atlas-canvas")).filter((call) => call.op === "strokeRect" && call.stroke === "#f59e0b");
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, clientX: 2, clientY: 2 });
      dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 28, clientY: 12 });
    });
    expect(rings()).toHaveLength(2);
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { pointerId: 2, clientX: 30, clientY: 12 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 1, clientX: 28, clientY: 12 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 2, clientX: 30, clientY: 12 });
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(rings()).toHaveLength(1);
    expect(screen.getByTestId("atlas-cell-2").getAttribute("aria-pressed")).toBe("true");
  });

  it("draws host marks on their tiles and host content over the atlas", () => {
    sizeSurface(64, 32);
    const drawn = recordCanvas();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={0}
        selectedIds={[]}
        onSelect={() => {}}
        panZoom
        cellMarks={new Map([[1, "dot"], [2, "dim"]])}
        overlay={<div data-testid="ghost" />}
        data-testid="atlas"
      />,
    );
    const canvas = screen.getByTestId("atlas-canvas");
    expect(canvas.dataset.dotTiles).toBe("1");
    expect(canvas.dataset.dimTiles).toBe("2");
    const calls = drawn(canvas);
    expect(calls.filter((call) => call.op === "arc")).toHaveLength(2);
    expect(calls.filter((call) => call.op === "fillRect" && call.fill === "#0a0a0a")).toHaveLength(1);
    expect(screen.getByTestId("atlas-cell-1").getAttribute("aria-pressed")).toBe("false");
    // The overlay sits in the atlas's pixel space, so it pans and zooms with it.
    expect((screen.getByTestId("ghost").parentElement as HTMLElement).style.transform)
      .toBe(screen.getByTestId("atlas-image").style.transform);
  });

  it("drags a tile off the sheet with the mouse instead of panning, and pans from touch or empty surface", () => {
    const calls: Array<[string, ...unknown[]]> = [];
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
            calls.push(["start", tileId]);
            return tileId === 1;
          },
          move: (x, y) => calls.push(["move", x, y]),
          end: (drop) => calls.push(["end", drop]),
        }}
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    placeImage("atlas", { left: 0, top: 0, width: 32, height: 16 });
    const mouse = { pointerType: "mouse" as const, button: 0 };
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { ...mouse, pointerId: 1, clientX: 4, clientY: 8 });
      // Inside the tap distance the press is still a tap.
      dispatchPointerEvent(surface, "pointermove", { ...mouse, pointerId: 1, clientX: 8, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { ...mouse, pointerId: 1, clientX: 60, clientY: 40 });
      dispatchPointerEvent(surface, "pointerup", { ...mouse, pointerId: 1, clientX: 70, clientY: 50 });
    });
    expect(calls).toEqual([["start", 1], ["move", 60, 40], ["end", { clientX: 70, clientY: 50 }]]);
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    fireEvent.click(screen.getByTestId("atlas-cell-1"));
    expect(onSelect).not.toHaveBeenCalled();

    // A click on the draggable tile is still a click.
    calls.length = 0;
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { ...mouse, pointerId: 2, clientX: 4, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { ...mouse, pointerId: 2, clientX: 4, clientY: 8 });
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(calls).toEqual([["start", 1]]);

    // A second finger cancels a drag in progress.
    calls.length = 0;
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { ...mouse, pointerId: 3, clientX: 4, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { ...mouse, pointerId: 3, clientX: 40, clientY: 8 });
      dispatchPointerEvent(surface, "pointerdown", { pointerId: 4, clientX: 20, clientY: 8 });
    });
    expect(calls.at(-1)).toEqual(["end", null]);
    act(() => {
      dispatchPointerEvent(surface, "pointerup", { pointerId: 4, clientX: 20, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { ...mouse, pointerId: 3, clientX: 40, clientY: 8 });
    });

    // Touch never drags a tile: it pans, as does a mouse press on a tile the host declines.
    calls.length = 0;
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { pointerId: 5, clientX: 4, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerId: 5, clientX: 44, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 5, clientX: 44, clientY: 8 });
    });
    expect(calls).toEqual([]);
    expect(surface.getAttribute("data-pan-x")).toBe("40");
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", { ...mouse, pointerId: 6, clientX: 20, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { ...mouse, pointerId: 6, clientX: 40, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { ...mouse, pointerId: 6, clientX: 40, clientY: 8 });
    });
    expect(calls).toEqual([["start", 2]]);
    expect(surface.getAttribute("data-pan-x")).toBe("60");
  });

  it("reports the tile under a hovering mouse, never under touch", () => {
    const onTileHover = vi.fn();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        onTileHover={onTileHover}
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    placeImage("atlas", { left: 0, top: 0, width: 32, height: 16 });
    act(() => {
      dispatchPointerEvent(surface, "pointermove", { pointerType: "mouse", clientX: 4, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerType: "mouse", clientX: 6, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerType: "mouse", clientX: 20, clientY: 8 });
      dispatchPointerEvent(surface, "pointermove", { pointerType: "touch", clientX: 4, clientY: 8 });
    });
    // Each tile is reported once, however often the mouse moves inside it.
    expect(onTileHover.mock.calls).toEqual([[1], [2]]);
    // React derives pointer leave from a pointerout whose next target is outside.
    const leave = new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body });
    Object.defineProperty(leave, "pointerType", { value: "mouse" });
    act(() => {
      surface.dispatchEvent(leave);
    });
    expect(onTileHover).toHaveBeenLastCalledWith(0);
  });

  it("zooms about the surface centre through its handle", () => {
    sizeSurface(100, 100);
    const handle = createRef<AtlasTileGridHandle>();
    render(
      <AtlasTileGrid
        ref={handle}
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={1}
        onSelect={() => {}}
        panZoom
        data-testid="atlas"
      />,
    );
    const surface = screen.getByTestId("atlas-surface");
    // Fit: 0.92 × min(100 / 32, 100 / 16) = 2.875, centred.
    const fitPanX = (100 - 32 * 2.875) / 2;
    expect(Number(surface.getAttribute("data-zoom"))).toBeCloseTo(2.875);
    act(() => handle.current!.zoomBy(2));
    expect(Number(surface.getAttribute("data-zoom"))).toBeCloseTo(5.75);
    // The centre (50, 50) keeps the atlas point it showed.
    expect(Number(surface.getAttribute("data-pan-x"))).toBeCloseTo(50 - (50 - fitPanX) * 2);
    act(() => handle.current!.zoomBy(0.5));
    expect(Number(surface.getAttribute("data-zoom"))).toBeCloseTo(2.875);
    expect(Number(surface.getAttribute("data-pan-x"))).toBeCloseTo(fitPanX);
  });

  it("selects the focus cell's tile on a click without pan and zoom", () => {
    const onSelect = vi.fn();
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl={null}
        selectedId={2}
        onSelect={onSelect}
        data-testid="tileset-preview"
      />,
    );
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
    restorers.push(() => vi.unstubAllGlobals());
    let size = { width: 64, height: 32 };
    for (const key of ["clientWidth", "clientHeight"] as const) {
      const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute("data-testid") === "atlas-surface" ? size[key === "clientWidth" ? "width" : "height"] : 0;
        },
      });
      restorers.push(() => {
        if (previous) Object.defineProperty(HTMLElement.prototype, key, previous);
        else Reflect.deleteProperty(HTMLElement.prototype, key);
      });
    }
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
    dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, clientX: 80, clientY: 80 });
    dispatchPointerEvent(surface, "pointerdown", { pointerId: 2, clientX: 120, clientY: 80 });
    dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 120, clientY: 80 });
    dispatchPointerEvent(surface, "pointermove", { pointerId: 2, clientX: 160, clientY: 80 });
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
    expect(surface.getAttribute("data-tool")).toBe("move");
    expect(surface.getAttribute("data-pan-x")).toBe("0");
    dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, clientX: 80, clientY: 80 });
    dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 120, clientY: 80 });
    await waitFor(() => {
      expect(Number(surface.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
  });

  it("selects the focus cell on a click and ignores the click a drag leaves", () => {
    const onSelect = vi.fn();
    HTMLElement.prototype.setPointerCapture = () => {};
    render(
      <AtlasTileGrid
        tileset={twoTileSet()}
        imageUrl="blob:atlas"
        selectedId={2}
        onSelect={onSelect}
        panZoom
        data-testid="atlas"
      />,
    );
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).toHaveBeenCalledWith(2);
    onSelect.mockClear();
    const surface = screen.getByTestId("atlas-surface");
    dispatchPointerEvent(surface, "pointerdown", { pointerId: 1, clientX: 80, clientY: 80 });
    dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 120, clientY: 80 });
    dispatchPointerEvent(surface, "pointerup", { pointerId: 1, clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("atlas-cell-2"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("atlas-cell-2"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
  });
});
