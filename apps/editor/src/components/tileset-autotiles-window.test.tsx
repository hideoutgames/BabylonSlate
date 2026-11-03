import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import {
  AUTOTILE_LAYOUTS,
  ensureTilesetTiles,
  normalizeTilesetPayload,
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
  type TilesetTerrain,
} from "@haptic/assets";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { TilesetEditingProvider } from "../context/tileset-editing-context";
import { TilesetAutotiles } from "./tileset-autotiles-window";

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({})));

afterEach(() => {
  cleanup();
});

const N = TERRAIN_N;
const NE = TERRAIN_NE;
const E = TERRAIN_E;
const SE = TERRAIN_SE;
const S = TERRAIN_S;
const SW = TERRAIN_SW;
const W = TERRAIN_W;
const NW = TERRAIN_NW;

/** A `columns` × `rows` sheet of 16 px tiles; `members` maps tile ids to their membership. */
function sheet(
  columns: number,
  rows: number,
  terrains: TilesetTerrain[] = [],
  members: Record<number, { id: string; mask: number }> = {},
): Record<string, unknown> {
  const base = ensureTilesetTiles(normalizeTilesetPayload({
    atlasWidth: columns * 16,
    atlasHeight: rows * 16,
    tileWidth: 16,
    tileHeight: 16,
    terrains,
  }));
  return {
    ...base,
    tiles: base.tiles.map((tile) => (members[tile.id] ? { ...tile, terrain: members[tile.id] } : tile)),
  } as unknown as Record<string, unknown>;
}

const GROUND_SIDES: TilesetTerrain = { id: "ground", name: "Ground", style: "sides" };
const GROUND_BLOB: TilesetTerrain = { id: "ground", name: "Ground", style: "blob" };
const WATER: TilesetTerrain = { id: "water", name: "Water", style: "sides" };

/** Every 4 Sides piece on a 4 × 4 sheet, laid out as the standard block. */
function sidesBlock(): Record<number, { id: string; mask: number }> {
  return Object.fromEntries(AUTOTILE_LAYOUTS.sides.masks.map((mask, at) => [at + 1, { id: "ground", mask: mask! }]));
}

function Harness({
  initial,
  onChange,
}: {
  initial: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey: string) => void;
}) {
  const [payload, setPayload] = useState(initial);
  return (
    <TilesetEditingProvider>
      <TilesetAutotiles
        payload={payload}
        onChange={(next, mergeKey) => {
          setPayload(next);
          onChange(next, mergeKey);
        }}
      />
    </TilesetEditingProvider>
  );
}

function renderWindow(initial: Record<string, unknown>) {
  const onChange = vi.fn<(next: Record<string, unknown>, mergeKey: string) => void>();
  render(<Harness initial={initial} onChange={onChange} />);
  const last = () => normalizeTilesetPayload(onChange.mock.lastCall![0]);
  const members = () => last().tiles.flatMap((tile) => (tile.terrain ? [[tile.id, tile.terrain.id, tile.terrain.mask]] : []));
  return { onChange, last, members };
}

const slot = (mask: number) => screen.getByTestId(`tileset-autotiles-slot-${mask}`);
const cell = (tileId: number) => screen.getByTestId(`tileset-autotiles-sheet-cell-${tileId}`);
const pressed = (element: HTMLElement) => element.getAttribute("aria-pressed") === "true";

describe("TilesetAutotiles", () => {
  it("creates an autotile with its Layout chosen up front and starts on its first piece", () => {
    const { onChange, last } = renderWindow(sheet(4, 4));
    expect(screen.getByTestId("tileset-autotiles-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tileset-autotiles-empty-new"));
    const dialog = within(screen.getByTestId("tileset-autotiles-create-dialog"));
    expect((dialog.getByTestId("tileset-autotiles-create-name") as HTMLInputElement).value).toBe("Autotile");
    const create = dialog.getByTestId("tileset-autotiles-create-submit") as HTMLButtonElement;
    // No Layout is assumed: Create waits for one.
    expect(create.disabled).toBe(true);
    fireEvent.click(dialog.getByTestId("tileset-autotiles-create-layout-blob"));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(last().terrains).toEqual([{ id: "terrain-1", name: "Autotile", style: "blob" }]);
    expect(screen.queryByTestId("tileset-autotiles-create-dialog")).toBeNull();
    expect(screen.getAllByTestId(/^tileset-autotiles-slot-\d+$/)).toHaveLength(47);
    expect(screen.getByTestId("tileset-autotiles-coverage").textContent).toBe("0 of 47 Pieces");
    // The board starts on its first piece: the island's top-left.
    expect(pressed(slot(E | S | SE))).toBe(true);

    fireEvent.click(screen.getByTestId("tileset-autotiles-new"));
    const second = within(screen.getByTestId("tileset-autotiles-create-dialog"));
    const name = second.getByTestId("tileset-autotiles-create-name") as HTMLInputElement;
    expect(name.value).toBe("Autotile 2");
    fireEvent.change(name, { target: { value: "Autotile" } });
    fireEvent.click(second.getByTestId("tileset-autotiles-create-layout-sides"));
    fireEvent.click(second.getByTestId("tileset-autotiles-create-submit"));
    expect(second.getByText("Another autotile is already named Autotile.")).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("assigns a tile to the selected piece and moves on to the next empty one", () => {
    const { onChange, members } = renderWindow(sheet(4, 4, [GROUND_SIDES, WATER], { 16: { id: "water", mask: 0 } }));
    expect(pressed(slot(E | S))).toBe(true);
    fireEvent.click(cell(5));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall![1]).toBe(`tileset:autotile:ground:piece:${E | S}:5`);
    // 4 Sides pieces store their corners filled.
    expect(members()).toEqual([[5, "ground", E | S | SE], [16, "water", 0]]);
    expect(slot(E | S).getAttribute("data-tile-id")).toBe("5");
    expect(screen.getByTestId("tileset-autotiles-sheet-piece-5").getAttribute("data-mask")).toBe(String(E | S));
    expect(pressed(slot(E | S))).toBe(false);
    expect(pressed(slot(E | S | W))).toBe(true);
    expect(screen.getByTestId("tileset-autotiles-coverage").textContent).toBe("1 of 16 Pieces");

    // Another autotile's tile is dimmed; assigning it moves it over.
    expect(screen.getByTestId("tileset-autotiles-sheet-other-16")).toBeTruthy();
    fireEvent.click(cell(16));
    expect(members()).toEqual([[5, "ground", E | S | SE], [16, "ground", E | S | W | SE | SW]]);
    expect(pressed(slot(S | W))).toBe(true);

    // One tile per piece: a new tile for E | S takes the piece from tile 5.
    fireEvent.click(slot(E | S));
    expect(pressed(cell(5))).toBe(true);
    fireEvent.click(cell(8));
    expect(members()).toEqual([[8, "ground", E | S | SE], [16, "ground", E | S | W | SE | SW]]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("assigns a tapped tile to the piece tapped next", () => {
    const { onChange, members } = renderWindow(sheet(4, 4, [GROUND_SIDES]));
    // Tapping the selected piece again clears the selection, so the sheet picks a tile instead.
    fireEvent.click(slot(E | S));
    expect(pressed(slot(E | S))).toBe(false);
    fireEvent.click(cell(9));
    expect(onChange).not.toHaveBeenCalled();
    expect(pressed(cell(9))).toBe(true);
    expect(screen.getByTestId("tileset-autotiles-status").textContent).toBe("Tile 9: tap a piece to assign it.");
    fireEvent.click(slot(N));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.anything(), `tileset:autotile:ground:piece:${N}:9`);
    expect(members()).toEqual([[9, "ground", N]]);
    expect(pressed(cell(9))).toBe(false);
  });

  it("clears pieces from the piece menu, the Delete key and the sheet tile menu, and moves with Arrow keys", () => {
    const { onChange, members } = renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
    fireEvent.contextMenu(slot(E | S));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear Piece" }));
    expect(onChange.mock.lastCall![1]).toBe(`tileset:autotile:ground:clear:${E | S}`);
    expect(members().map(([id]) => id)).not.toContain(1);
    expect(pressed(slot(E | S))).toBe(true);

    slot(E | S).focus();
    fireEvent.keyDown(slot(E | S), { key: "ArrowRight" });
    expect(pressed(slot(E | S | W))).toBe(true);
    expect(document.activeElement).toBe(slot(E | S | W));
    fireEvent.keyDown(slot(E | S | W), { key: "ArrowDown" });
    expect(document.activeElement).toBe(slot(N | E | S | W));
    fireEvent.keyDown(slot(N | E | S | W), { key: "Delete" });
    expect(members().map(([id]) => id)).not.toContain(6);

    // Show On Sheet selects the piece and highlights its tile.
    fireEvent.contextMenu(slot(N));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show On Sheet" }));
    expect(pressed(slot(N))).toBe(true);
    expect(pressed(cell(12))).toBe(true);

    fireEvent.contextMenu(cell(3));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove From Autotile" }));
    expect(onChange.mock.lastCall![1]).toBe("tileset:autotile:ground:remove:3");
    expect(members().map(([id]) => id)).not.toContain(3);
    // A tile outside the autotile has nothing to remove.
    fireEvent.contextMenu(cell(3));
    expect((screen.getByRole("menuitem", { name: "Remove From Autotile" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("places a template over the sheet, refuses spots past its edge and applies it as one undo step", () => {
    // A 6 × 5 sheet: tile id = row × 6 + column + 1.
    const { onChange, members } = renderWindow(sheet(6, 5, [GROUND_BLOB], { 30: { id: "ground", mask: TERRAIN_ALL } }));
    fireEvent.click(screen.getByTestId("tileset-autotiles-fill-template"));
    // The 12 × 4 Blob block does not fit a 6 × 5 sheet.
    expect(screen.getByTestId("tileset-autotiles-template-blob-block").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("tileset-autotiles-template-island"));
    const anchor = () => screen.getByTestId("tileset-autotiles-placement").getAttribute("data-anchor");
    const status = () => screen.getByTestId("tileset-autotiles-placement-status").textContent;
    expect(anchor()).toBe("1");
    const apply = screen.getByTestId("tileset-autotiles-placement-apply");
    expect(apply.textContent).toBe("Assign 9 Pieces");
    // Tile 30 already draws the island's centre piece, which the block takes over.
    expect(status()).toBe("Replaces 1 Assignment");

    // From column 5 of 6 the 3 × 3 block runs past the right edge.
    fireEvent.click(cell(5));
    expect(anchor()).toBe("1");
    expect(status()).toBe("That spot runs past the sheet.");
    fireEvent.click(cell(4));
    expect(anchor()).toBe("4");
    expect(status()).toBe("Replaces 1 Assignment");

    // Dragging the block by one of its tiles moves it with the pointer, and stops at the sheet's edge.
    const surface = screen.getByTestId("tileset-autotiles-sheet-surface");
    cell(1).parentElement!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 96, height: 80 }) as DOMRect;
    act(() => dispatchPointerEvent(cell(5), "pointerdown", { pointerId: 1, clientX: 72, clientY: 8 }));
    act(() => dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 56, clientY: 24 }));
    expect(anchor()).toBe("9");
    act(() => {
      dispatchPointerEvent(surface, "pointermove", { pointerId: 1, clientX: 8, clientY: 8 });
      dispatchPointerEvent(surface, "pointerup", { pointerId: 1, clientX: 8, clientY: 8 });
    });
    expect(anchor()).toBe("1");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(apply);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.anything(), "tileset:autotile:ground:template:island:1");
    expect(members()).toEqual([
      [1, "ground", E | S | SE], [2, "ground", E | S | W | SE | SW], [3, "ground", S | W | SW],
      [7, "ground", N | E | S | NE | SE], [8, "ground", TERRAIN_ALL], [9, "ground", N | S | W | NW | SW],
      [13, "ground", N | E | NE], [14, "ground", N | E | W | NE | NW], [15, "ground", N | W | NW],
    ]);
    expect(screen.queryByTestId("tileset-autotiles-placement-bar")).toBeNull();
    expect(screen.getByTestId("tileset-autotiles-coverage").textContent).toBe("9 of 47 Pieces");
  });

  it("cancels a placement without editing", () => {
    const { onChange } = renderWindow(sheet(4, 4, [GROUND_SIDES]));
    fireEvent.click(screen.getByTestId("tileset-autotiles-fill-template"));
    fireEvent.click(screen.getByTestId("tileset-autotiles-template-sides-block"));
    expect(screen.getByTestId("tileset-autotiles-placement-apply").textContent).toBe("Assign 16 Pieces");
    fireEvent.click(screen.getByTestId("tileset-autotiles-placement-cancel"));
    expect(screen.queryByTestId("tileset-autotiles-placement")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  describe("Test Paint", () => {
    /** Press the map's cell at map coordinates (+Y up) with a 10 px grid. */
    const press = (x: number, y: number, pointerId = 1) => {
      const map = screen.getByTestId("tileset-autotiles-test-map");
      map.getBoundingClientRect = () => ({ left: 0, top: 0, width: 140, height: 90 }) as DOMRect;
      const point = { pointerId, clientX: x * 10 + 5, clientY: (8 - y) * 10 + 5 };
      act(() => dispatchPointerEvent(map, "pointerdown", point));
      return {
        to: (nx: number, ny: number) =>
          act(() => dispatchPointerEvent(map, "pointermove", { pointerId, clientX: nx * 10 + 5, clientY: (8 - ny) * 10 + 5 })),
        up: () => act(() => dispatchPointerEvent(map, "pointerup", point)),
      };
    };
    const tileAt = (x: number, y: number) => screen.getByTestId(`tileset-autotiles-test-cell-${x}-${y}`).getAttribute("data-tile-id");

    it("paints the sample with the pieces a Tilemap brush picks, and paints, erases and resets", () => {
      renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
      const map = screen.getByTestId("tileset-autotiles-test-map");
      // The island's top-left is the block's first tile; the single is its last.
      expect(tileAt(1, 7)).toBe("1");
      expect(tileAt(11, 5)).toBe("16");
      expect(map.querySelectorAll("[data-stand-in]")).toHaveLength(0);

      fireEvent.click(screen.getByTestId("tileset-autotiles-test-erase-tool"));
      press(3, 5).up();
      expect(tileAt(3, 5)).toBe("0");
      // The cell above the hole loses its south neighbour: the N | E | W piece, tile 10.
      expect(tileAt(3, 6)).toBe("10");

      fireEvent.click(screen.getByTestId("tileset-autotiles-test-paint-tool"));
      const stroke = press(10, 3);
      stroke.to(12, 3);
      stroke.up();
      // A three-cell horizontal strip, with the skipped middle cell filled in: E, E | W, W.
      expect([tileAt(10, 3), tileAt(11, 3), tileAt(12, 3)]).toEqual(["13", "14", "15"]);

      fireEvent.click(screen.getByTestId("tileset-autotiles-test-reset"));
      expect(tileAt(3, 5)).toBe("6");
      expect(tileAt(11, 3)).toBe("0");
    });

    it("outlines cells drawn with a stand-in, and picks the piece a cell wanted", () => {
      // Every piece but the single (tile 16).
      const members = sidesBlock();
      delete members[16];
      renderWindow(sheet(4, 4, [GROUND_SIDES], members));
      const single = screen.getByTestId("tileset-autotiles-test-cell-11-5");
      expect(single.getAttribute("data-stand-in")).toBe("true");
      expect(screen.getByTestId("tileset-autotiles-test-stand-ins").textContent).toBe("1 cell uses a stand-in tile.");
      expect(screen.getByTestId("tileset-autotiles-test-cell-1-7").getAttribute("data-stand-in")).toBeNull();

      fireEvent.click(screen.getByTestId("tileset-autotiles-test-pick-tool"));
      press(11, 5).up();
      expect(pressed(slot(0))).toBe(true);
      press(1, 7).up();
      expect(pressed(slot(E | S))).toBe(true);
    });
  });

  it("changes the Layout after saying what happens to assigned pieces", () => {
    const { onChange, last } = renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
    fireEvent.click(screen.getByTestId("tileset-autotiles-actions"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Blob (47 Pieces)" }));
    const dialog = within(screen.getByTestId("tileset-autotiles-layout-dialog"));
    expect(dialog.getByText("Pieces keep their tiles. As Blob, 16 of 47 pieces have a tile and 31 are missing.")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByTestId("tileset-autotiles-layout-confirm"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.anything(), "tileset:autotile:ground:layout:blob");
    expect(last().terrains).toEqual([{ ...GROUND_SIDES, style: "blob" }]);
    // The tiles keep their masks.
    expect(last().tiles.filter((tile) => tile.terrain)).toHaveLength(16);
    expect(screen.getByTestId("tileset-autotiles-coverage").textContent).toBe("16 of 47 Pieces");
  });

  it("renames and deletes an autotile, taking its tiles out of it", () => {
    const { onChange, last } = renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
    fireEvent.click(screen.getByTestId("tileset-autotiles-actions"));
    fireEvent.click(screen.getByTestId("tileset-autotiles-rename"));
    const rename = within(screen.getByTestId("tileset-autotiles-rename-dialog"));
    fireEvent.change(rename.getByLabelText("Name"), { target: { value: "Ledge" } });
    fireEvent.click(rename.getByRole("button", { name: "Rename" }));
    expect(last().terrains).toEqual([{ ...GROUND_SIDES, name: "Ledge" }]);

    fireEvent.click(screen.getByTestId("tileset-autotiles-actions"));
    fireEvent.click(screen.getByTestId("tileset-autotiles-delete"));
    fireEvent.click(screen.getByTestId("tileset-autotiles-delete-confirm"));
    expect(onChange.mock.lastCall![1]).toBe("tileset:autotile:ground:delete");
    expect(last().terrains).toBeUndefined();
    expect(last().tiles.some((tile) => tile.terrain)).toBe(false);
    expect(screen.getByTestId("tileset-autotiles-empty")).toBeTruthy();
  });
});
