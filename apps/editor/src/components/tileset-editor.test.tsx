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
import { useState } from "react";
import {
  createDefaultTilesetPayload,
  normalizeTilesetPayload,
} from "@haptic/assets";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { tapAtlasTile } from "../../../../packages/editor-kit/src/test-support/atlas-tile-grid";
import { TilesetEditingProvider } from "../context/tileset-editing-context";
import { TilesetAutotiles } from "./tileset-autotiles-window";
import { TilesetEditor, TilesetPreview } from "./tileset-editor";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const readAssetChunk = vi.hoisted(() =>
  vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
);
const dock = vi.hoisted(() => ({
  open: false,
  toggleDockWindow: vi.fn(),
  activateDockPanel: vi.fn(),
}));

vi.mock("../context/document-context", async () => {
  const assets = [
    {
      header: { guid: "tex-1", name: "GroundAtlas", type: "Texture" },
      path: "assets/GroundAtlas.texture.hasset",
    },
  ];
  return (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: {
      getByGuid: (guid: string) => assets.find((asset) => asset.header.guid === guid),
      list: () => assets,
    },
    readAssetChunk,
    projectDocument: {
      settings: { twoD: { sortingLayers: ["Default", "Foreground"] } },
    },
    isDockWindowOpen: () => dock.open,
    toggleDockWindow: dock.toggleDockWindow,
    activateDockPanel: dock.activateDockPanel,
  }));
});

afterEach(() => {
  cleanup();
  readAssetChunk.mockClear();
  dock.toggleDockWindow.mockClear();
  dock.activateDockPanel.mockClear();
});

function twoTilePayload(overrides: Record<string, unknown> = {}) {
  return {
    ...createDefaultTilesetPayload(),
    atlasWidth: 32,
    atlasHeight: 16,
    tileWidth: 16,
    tileHeight: 16,
    ...overrides,
  };
}

function TilesetHarness({
  initial,
  onChange,
}: {
  initial: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [payload, setPayload] = useState(initial);
  const commit = (next: Record<string, unknown>) => {
    setPayload(next);
    onChange(next);
  };
  return (
    <TilesetEditingProvider>
      <TilesetPreview payload={payload} onChange={commit} />
      <TilesetEditor payload={payload} onChange={commit} />
    </TilesetEditingProvider>
  );
}

describe("TilesetEditor", () => {
  it("identifies a missing tileset texture without a loading dead end", () => {
    render(<TilesetPreview payload={twoTilePayload({ textureGuid: "missing" })} />);
    expect(screen.getByText("Missing Texture")).toBeTruthy();
    expect(screen.queryByText(/Loading texture/i)).toBeNull();
  });

  it("assigns a Texture from the empty Preview", async () => {
    const onChange = vi.fn();
    render(<TilesetPreview payload={twoTilePayload()} onChange={onChange} />);
    expect(screen.getByText("No Texture")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tileset-preview-pick-texture"));
    fireEvent.click(await screen.findByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ textureGuid: "tex-1" }),
    );
  });

  it("waits for confirmation before applying both tile dimensions", () => {
    const onChange = vi.fn();
    render(<TilesetHarness initial={twoTilePayload()} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("property-tileWidth"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByTestId("property-tileHeight"), {
      target: { value: "8" },
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tileset-preview-cell-3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Tile Size" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tileWidth: 8,
        tileHeight: 8,
        tiles: expect.arrayContaining([expect.objectContaining({ id: 8 })]),
      }),
    );
    // The rebuilt grid has 8 tiles of 8 px: the last one can be picked.
    tapAtlasTile("tileset-preview", 8, { width: 8, height: 8 });
    expect(screen.getByTestId("tileset-selected-label").textContent).toBe("Tile 8");
  });

  it("authors per-tile collision, flags, and animation", async () => {
    const payload = twoTilePayload();
    const onChange = vi.fn();
    render(
      <TilesetEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("tileset-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-flags-bit-0"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1, flags: 1 }),
        ]),
      }),
    );
    fireEvent.change(screen.getByTestId("property-animation"), {
      target: { value: "1, 2" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1, animation: [1, 2] }),
        ]),
      }),
    );
    fireEvent.click(screen.getByTestId("property-collision"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Chain" })).toBeTruthy();
    });
    expect(screen.getByRole("option", { name: "Full" })).toBeTruthy();
    expect((screen.getByTestId("property-animationFrameDurationMs") as HTMLInputElement).value).toBe("100 ms");
    fireEvent.change(screen.getByTestId("property-animationFrameDurationMs"), { target: { value: "250" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      tiles: expect.arrayContaining([expect.objectContaining({ id: 1, animationFrameDurationMs: 250 })]),
    }), expect.any(String));
  });

  it("counts the autotiles and opens the Autotiles window from Edit Autotiles", () => {
    dock.open = false;
    const { rerender } = render(
      <TilesetEditor payload={twoTilePayload()} onChange={() => {}} />,
    );
    expect(screen.getByTestId("tileset-autotiles-count").textContent).toBe("No Autotiles");
    fireEvent.click(screen.getByTestId("tileset-edit-autotiles"));
    // A closed window opens first; either way it comes to the front.
    expect(dock.toggleDockWindow).toHaveBeenCalledExactlyOnceWith("tileset-autotiles");
    expect(dock.activateDockPanel).toHaveBeenCalledExactlyOnceWith("tileset-autotiles");

    dock.open = true;
    rerender(
      <TilesetEditor
        payload={twoTilePayload({
          terrains: [{ id: "grass", name: "Grass", style: "blob" }, { id: "ledge", name: "Ledge", style: "sides" }],
          tiles: [{ id: 1, collision: "none", flags: 0, animation: [], terrain: { id: "grass", mask: 0 } }],
        })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("tileset-autotiles-count").textContent).toBe("2 Autotiles");
    // The selected tile still names its autotile.
    expect(screen.getByTestId("tileset-selected-terrain").textContent).toBe("Grass");
    fireEvent.click(screen.getByTestId("tileset-edit-autotiles"));
    expect(dock.toggleDockWindow).toHaveBeenCalledTimes(1);
    expect(dock.activateDockPanel).toHaveBeenCalledTimes(2);
  });

  it("keeps atlas size fields read-only", () => {
    render(
      <TilesetEditor
        payload={twoTilePayload() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    expect(
      (screen.getByTestId("property-atlasWidth") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("property-atlasHeight") as HTMLInputElement).disabled,
    ).toBe(true);
  });
});

describe("TilesetPreview", () => {
  it("drags a rectangular selection and edits all selected tiles together", () => {
    const onChange = vi.fn();
    render(
      <TilesetHarness
        initial={twoTilePayload({ atlasWidth: 48, atlasHeight: 32 })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("tileset-tool-select"));
    const surface = screen.getByTestId("tileset-preview-surface");
    screen.getByTestId("tileset-preview-image").getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 96, height: 64 }) as DOMRect;
    act(() => {
      dispatchPointerEvent(surface, "pointerdown", {
        pointerId: 1,
        clientX: 4,
        clientY: 4,
      });
      dispatchPointerEvent(surface, "pointermove", {
        pointerId: 1,
        clientX: 52,
        clientY: 52,
      });
      dispatchPointerEvent(surface, "pointerup", {
        pointerId: 1,
        clientX: 52,
        clientY: 52,
      });
    });
    // The click a drag leaves on the focus cell does not replace the selection.
    fireEvent.click(screen.getByTestId("tileset-preview-cell-1"));
    expect(screen.getByTestId("tileset-selected-label").textContent).toBe("4 Tiles");
    expect(screen.getByTestId("tileset-preview-cell-1").getAttribute("aria-pressed")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tileset-collision-full"));
    fireEvent.click(screen.getByTestId("property-flags-bit-0"));
    fireEvent.change(screen.getByTestId("property-animation"), {
      target: { value: "1, 2" },
    });
    const tiles = onChange.mock.lastCall![0].tiles as Array<{
      id: number;
      collision: string;
      flags: number;
      animation: number[];
    }>;
    expect(
      tiles.filter((tile) => tile.collision === "full").map((tile) => tile.id),
    ).toEqual([1, 2, 4, 5]);
    expect(
      tiles.filter((tile) => tile.flags === 1).map((tile) => tile.id),
    ).toEqual([1, 2, 4, 5]);
    expect(
      tiles
        .filter((tile) => tile.animation.length === 2)
        .map((tile) => tile.id),
    ).toEqual([1, 2, 4, 5]);
  });

  it("selects either tile of a 32×16 sheet and moves the focus cell to it", () => {
    render(
      <TilesetEditingProvider>
        <TilesetPreview
          payload={twoTilePayload() as unknown as Record<string, unknown>}
        />
      </TilesetEditingProvider>,
    );
    expect(screen.getByTestId("tileset-preview-cell-1").getAttribute("aria-pressed")).toBe("true");
    tapAtlasTile("tileset-preview", 2);
    expect(screen.queryByTestId("tileset-preview-cell-1")).toBeNull();
    expect(screen.getByTestId("tileset-preview-cell-2").getAttribute("aria-pressed")).toBe("true");
  });

  it("defaults to Move and pans the atlas with one finger", async () => {
    HTMLElement.prototype.setPointerCapture = () => {};
    render(
      <TilesetEditingProvider>
        <TilesetPreview
          payload={twoTilePayload() as unknown as Record<string, unknown>}
        />
      </TilesetEditingProvider>,
    );
    // Autotiles are edited in their own window: the Preview offers only Move and Select.
    expect(
      within(screen.getByTestId("tileset-preview-tools"))
        .getAllByRole("button")
        .map((tool) => tool.textContent),
    ).toEqual(["Move", "Select"]);
    const surface = screen.getByTestId("tileset-preview-surface");
    expect(surface.getAttribute("data-tool")).toBe("move");
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
    dispatchPointerEvent(surface, "pointerdown", {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });
    dispatchPointerEvent(surface, "pointermove", {
      pointerId: 1,
      clientX: 80,
      clientY: 40,
    });
    await waitFor(() => {
      expect(Number(surface.getAttribute("data-pan-x") ?? "0")).toBe(40);
    });
  });

  it("writes Full collision on the tile selected in the preview", () => {
    const onChange = vi.fn();
    render(
      <TilesetHarness
        initial={twoTilePayload() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    tapAtlasTile("tileset-preview", 2);
    expect(screen.getByTestId("tileset-selected-label").textContent).toContain(
      "2",
    );
    fireEvent.click(screen.getByTestId("tileset-collision-full"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 2, collision: "full" }),
        ]),
      }),
    );
  });

  it("stamps the current collision onto other cells in Paint Collision mode", () => {
    const onChange = vi.fn();
    render(
      <TilesetHarness
        initial={twoTilePayload() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    tapAtlasTile("tileset-preview", 1);
    fireEvent.click(screen.getByTestId("tileset-collision-full"));
    fireEvent.click(screen.getByTestId("tileset-paint-collision"));
    tapAtlasTile("tileset-preview", 2);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 2, collision: "full" }),
        ]),
      }),
    );
  });

  it("assigns autotile pieces in the Autotiles window without painting collision", () => {
    const onChange = vi.fn();
    function Harness() {
      const [payload, setPayload] = useState<Record<string, unknown>>(
        twoTilePayload({ atlasWidth: 48, terrains: [{ id: "ground", name: "Ground", style: "sides" }] }),
      );
      const commit = (next: Record<string, unknown>) => {
        setPayload(next);
        onChange(next);
      };
      return (
        <TilesetEditingProvider>
          <TilesetPreview payload={payload} onChange={commit} />
          <TilesetAutotiles payload={payload} onChange={commit} />
        </TilesetEditingProvider>
      );
    }
    render(<Harness />);
    tapAtlasTile("tileset-preview", 1);
    fireEvent.click(screen.getByTestId("tileset-collision-full"));
    fireEvent.click(screen.getByTestId("tileset-paint-collision"));
    onChange.mockClear();
    tapAtlasTile("tileset-autotiles-sheet", 3);
    expect(onChange).toHaveBeenCalledTimes(1);
    const tile = normalizeTilesetPayload(onChange.mock.lastCall![0]).tiles.find((entry) => entry.id === 3);
    expect(tile).toMatchObject({ collision: "none", terrain: { id: "ground" } });
  });

  it("derives atlas size from the assigned texture", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:atlas");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const onChange = vi.fn();
    render(
      <TilesetEditingProvider>
        <TilesetPreview
          payload={
            twoTilePayload({ textureGuid: "tex-1" }) as unknown as Record<
              string,
              unknown
            >
          }
          onChange={onChange}
        />
      </TilesetEditingProvider>,
    );
    const img = await waitFor(() => {
      const found = document.querySelector("img");
      expect(found).toBeTruthy();
      return found as HTMLImageElement;
    });
    Object.defineProperty(img, "naturalWidth", { value: 64 });
    Object.defineProperty(img, "naturalHeight", { value: 32 });
    fireEvent.load(img);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        atlasWidth: 64,
        atlasHeight: 32,
        tiles: expect.arrayContaining([
          expect.objectContaining({ id: 1 }),
          expect.objectContaining({ id: 8 }),
        ]),
      }),
    );
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
