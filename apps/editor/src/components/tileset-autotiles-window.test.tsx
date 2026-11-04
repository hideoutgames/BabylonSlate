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
const NESW = N | E | S | W;

type Members = Record<number, { id: string; mask: number; border?: string }>;

/** A `columns` × `rows` sheet of 16 px tiles; `members` maps tile ids to their membership. */
function sheet(columns: number, rows: number, terrains: TilesetTerrain[] = [], members: Members = {}): Record<string, unknown> {
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

/** `mask` with each corner whose two sides it joins: how the editor stores a 4 Sides piece. */
function withFilledCorners(mask: number): number {
  let filled = mask;
  for (const [corner, sides] of [[NE, N | E], [SE, S | E], [SW, S | W], [NW, N | W]] as const) {
    if ((mask & sides) === sides) filled |= corner;
  }
  return filled;
}

/**
 * Every 4 Sides piece of Ground on tiles 1-16, laid out as the standard block:
 * E|S, E|S|W, S|W, S / N|E|S, fill, N|S|W, N|S / N|E, N|E|W, N|W, N / E, E|W, W, single.
 */
function sidesBlock(): Members {
  return Object.fromEntries(AUTOTILE_LAYOUTS.sides.masks.map((mask, at) => [at + 1, { id: "ground", mask: withFilledCorners(mask!) }]));
}

/** Ground's 4 Sides island drawn next to Water, on tiles 17-19, 21-23 and 25-27 of a 4-column sheet. */
function nextToWaterIsland(): Members {
  return Object.fromEntries(
    ([[17, E | S], [18, E | S | W], [19, S | W], [21, N | E | S], [22, NESW], [23, N | S | W], [25, N | E], [26, N | E | W], [27, N | W]] as const)
      .map(([id, mask]) => [id, { id: "ground", mask, border: "water" }]),
  );
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
  const mergeKey = () => onChange.mock.lastCall![1];
  return { onChange, last, members, mergeKey };
}

const byId = (id: string) => screen.getByTestId(id);
const queryId = (id: string) => screen.queryByTestId(id);
const slot = (mask: number) => byId(`tileset-autotiles-slot-${mask}`);
const slotClear = (mask: number) => queryId(`tileset-autotiles-slot-${mask}-clear`);
const cell = (tileId: number) => byId(`tileset-autotiles-sheet-cell-${tileId}`);
const row = (id: string) => byId(`tileset-autotiles-row-${id}`);
const previewCell = (x: number, y: number) => byId(`tileset-autotiles-preview-cell-${x}-${y}`);
const pressed = (element: HTMLElement) => element.getAttribute("aria-pressed") === "true";
const current = (element: HTMLElement) => element.getAttribute("aria-current") === "true";
const text = (id: string) => byId(id).textContent;
const pickedCells = () => screen.getAllByTestId(/^tileset-autotiles-preview-cell-\d+-\d+$/)
  .filter((element) => element.dataset.picked === "true")
  .map((element) => element.getAttribute("data-cell"));

/** A pointer moving onto (or off) `target` from outside it, as React reads enter and leave. */
function hover(target: Element, pointerType: "mouse" | "touch", leave = false) {
  const event = new MouseEvent(leave ? "pointerout" : "pointerover", { bubbles: true, relatedTarget: document.body });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Lays the sheet's atlas out at 1 client pixel per atlas pixel from (0, 0), so pointer positions name tiles. */
function layOutSheet(columns: number, rows: number) {
  cell(1).parentElement!.getBoundingClientRect = () => ({ left: 0, top: 0, width: columns * 16, height: rows * 16 }) as DOMRect;
}

describe("TilesetAutotiles", () => {
  it("creates a Blob autotile named Autotile, selects it and renames it in place", () => {
    const { onChange, last, mergeKey } = renderWindow(sheet(4, 4));
    fireEvent.click(byId("tileset-autotiles-empty-new"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(mergeKey()).toBe("tileset:autotile:terrain-1:create");
    expect(last().terrains).toEqual([{ id: "terrain-1", name: "Autotile", style: "blob" }]);
    // No dialog: the new row's name is an input, focused.
    const input = byId("tileset-autotiles-rename-terrain-1") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Grass" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mergeKey()).toBe("tileset:autotile:terrain-1:name");
    expect(last().terrains![0]!.name).toBe("Grass");
    expect(text("tileset-autotiles-pieces-title")).toBe("Grass");
    // Blob shows Main and Inner Corners; More Corners starts collapsed. The first piece is selected.
    expect(screen.getAllByTestId(/^tileset-autotiles-slot-\d+$/)).toHaveLength(20);
    expect(pressed(slot(E | S | SE))).toBe(true);
    expect(text("tileset-autotiles-group-more-corners-count")).toBe("0 of 27 · Optional");

    // A second one takes the next free name; a rename to a name in use takes the next free number.
    fireEvent.click(byId("tileset-autotiles-new"));
    expect(last().terrains![1]).toEqual({ id: "terrain-2", name: "Autotile", style: "blob" });
    const second = byId("tileset-autotiles-rename-terrain-2");
    fireEvent.change(second, { target: { value: "Grass" } });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(last().terrains![1]!.name).toBe("Grass 2");
    expect(current(row("terrain-2"))).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("switches the edited set only by selecting a row, border sets included", () => {
    renderWindow(sheet(4, 9, [{ ...GROUND_SIDES, borders: ["water"] }, WATER], { ...sidesBlock(), ...nextToWaterIsland() }));
    expect(current(row("ground"))).toBe(true);
    expect(text("tileset-autotiles-pieces-title")).toBe("Ground");
    expect(byId("tileset-autotiles-status-ground").dataset.ready).toBe("true");
    expect(byId("tileset-autotiles-status-ground").getAttribute("aria-label")).toBe("Every piece has a tile");
    expect(byId("tileset-autotiles-status-water").dataset.ready).toBe("false");
    expect(slot(E | S).dataset.tileId).toBe("1");

    fireEvent.click(row("ground-water"));
    expect(current(row("ground-water"))).toBe(true);
    expect(current(row("ground"))).toBe(false);
    expect(text("tileset-autotiles-pieces-title")).toBe("Ground · Next To Water");
    // A border set has no Layout of its own.
    expect(queryId("tileset-autotiles-layout-blob")).toBeNull();
    expect(slot(E | S).dataset.tileId).toBe("17");
    expect(text("tileset-autotiles-group-pieces-count")).toBe("9 of 16");
    // Its first empty piece is selected; the default set's tiles count as used elsewhere.
    expect(pressed(slot(S))).toBe(true);
    expect(queryId("tileset-autotiles-sheet-other-1")).toBeTruthy();
    expect(queryId("tileset-autotiles-sheet-piece-17")).toBeTruthy();

    fireEvent.click(row("water"));
    expect(text("tileset-autotiles-pieces-title")).toBe("Water");
    expect(queryId("tileset-autotiles-layout-blob")).toBeTruthy();
  });

  it("adds a set next to another autotile and removes it, asking only when tiles would leave", () => {
    const { last, mergeKey } = renderWindow(sheet(4, 9, [GROUND_SIDES, WATER], sidesBlock()));
    fireEvent.click(byId("tileset-autotiles-actions-ground"));
    fireEvent.click(byId("tileset-autotiles-add-border-water"));
    expect(mergeKey()).toBe("tileset:autotile:ground:border-add:water");
    expect(last().terrains![0]).toEqual({ ...GROUND_SIDES, borders: ["water"] });
    expect(current(row("ground-water"))).toBe(true);
    // An empty set paints the ordinary pieces, and says so.
    expect(text("tileset-autotiles-selected-tile")).toBe("No tile · painting uses Tile 1 instead");

    // Empty: removed at once.
    fireEvent.click(byId("tileset-autotiles-remove-border-ground-water"));
    expect(queryId("tileset-autotiles-remove-border-dialog")).toBeNull();
    expect(mergeKey()).toBe("tileset:autotile:ground:border-remove:water");
    expect(last().terrains![0]).toEqual(GROUND_SIDES);
    expect(current(row("ground"))).toBe(true);

    fireEvent.click(byId("tileset-autotiles-actions-ground"));
    fireEvent.click(byId("tileset-autotiles-add-border-water"));
    fireEvent.click(cell(17));
    expect(mergeKey()).toBe(`tileset:autotile:ground:piece:water:${E | S}:17`);
    expect(last().tiles[16]!.terrain).toEqual({ id: "ground", mask: E | S | SE, border: "water" });
    fireEvent.click(byId("tileset-autotiles-remove-border-ground-water"));
    const dialog = byId("tileset-autotiles-remove-border-dialog");
    expect(dialog.textContent).toContain("Its 1 tile leaves Ground");
    fireEvent.click(within(dialog).getByTestId("tileset-autotiles-remove-border-confirm"));
    expect(mergeKey()).toBe("tileset:autotile:ground:border-remove:water");
    expect(last().tiles.some((tile) => tile.terrain?.border)).toBe(false);
  });

  it("changes the Layout at once without tiles, and after saying what happens with them", () => {
    const empty = renderWindow(sheet(4, 4, [GROUND_SIDES]));
    fireEvent.click(byId("tileset-autotiles-layout-blob"));
    expect(empty.mergeKey()).toBe("tileset:autotile:ground:layout:blob");
    expect(byId("tileset-autotiles-group-main")).toBeTruthy();
    cleanup();

    const { onChange, last } = renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
    fireEvent.click(byId("tileset-autotiles-layout-blob"));
    const dialog = within(byId("tileset-autotiles-layout-dialog"));
    expect(dialog.getByText("Pieces keep their tiles. As Blob, 16 of 47 pieces have a tile and 31 are missing.")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByTestId("tileset-autotiles-layout-confirm"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.anything(), "tileset:autotile:ground:layout:blob");
    expect(last().terrains).toEqual([GROUND_BLOB]);
    // The tiles keep their masks: the island reads as Blob's Main.
    expect(text("tileset-autotiles-group-main-count")).toBe("16 of 16");
  });

  it("assigns a tapped sheet tile to the selected piece and moves on to the next empty one", () => {
    const { onChange, members, mergeKey } = renderWindow(sheet(4, 4, [GROUND_SIDES, WATER], { 16: { id: "water", mask: 0 } }));
    expect(pressed(slot(E | S))).toBe(true);
    expect(text("tileset-autotiles-selected-name")).toBe("Top-Left Corner");
    expect(text("tileset-autotiles-sheet-hint")).toBe("Click a tile for Top-Left Corner, or drag one onto any piece.");
    fireEvent.click(cell(5));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(mergeKey()).toBe(`tileset:autotile:ground:piece:default:${E | S}:5`);
    // 4 Sides pieces store their corners filled.
    expect(members()).toEqual([[5, "ground", E | S | SE], [16, "water", 0]]);
    expect(slot(E | S).dataset.tileId).toBe("5");
    expect(queryId("tileset-autotiles-sheet-piece-5")).toBeTruthy();
    expect(pressed(slot(E | S | W))).toBe(true);
    expect(text("tileset-autotiles-group-pieces-count")).toBe("1 of 16");

    // Another autotile's tile is dimmed; assigning it moves it over.
    expect(queryId("tileset-autotiles-sheet-other-16")).toBeTruthy();
    fireEvent.click(cell(16));
    expect(members()).toEqual([[5, "ground", E | S | SE], [16, "ground", E | S | W | SE | SW]]);
    expect(pressed(slot(S | W))).toBe(true);

    // One tile per piece: a new tile for E | S takes the piece from tile 5. The selected piece's tile is ringed on the sheet.
    fireEvent.click(slot(E | S));
    expect(pressed(cell(5))).toBe(true);
    expect(text("tileset-autotiles-selected-tile")).toBe("Tile 5");
    fireEvent.click(cell(8));
    expect(members()).toEqual([[8, "ground", E | S | SE], [16, "ground", E | S | W | SE | SW]]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("drags a sheet tile onto any piece with the mouse", () => {
    const { mergeKey, members } = renderWindow(sheet(4, 4, [GROUND_SIDES]));
    layOutSheet(4, 4);
    const surface = byId("tileset-autotiles-sheet-surface");
    const original = document.elementFromPoint;
    document.elementFromPoint = () => slot(N);
    try {
      const mouse = { pointerType: "mouse" as const, button: 0, pointerId: 1 };
      // Tile 9: column 0, row 2.
      act(() => dispatchPointerEvent(cell(9), "pointerdown", { ...mouse, clientX: 8, clientY: 40 }));
      act(() => dispatchPointerEvent(surface, "pointermove", { ...mouse, clientX: 300, clientY: 300 }));
      expect(byId("tileset-autotiles-drag-tile").dataset.tileId).toBe("9");
      expect(slot(N).dataset.dropTarget).toBe("true");
      act(() => dispatchPointerEvent(surface, "pointerup", { ...mouse, clientX: 300, clientY: 300 }));
    } finally {
      document.elementFromPoint = original;
    }
    expect(mergeKey()).toBe(`tileset:autotile:ground:piece:default:${N}:9`);
    expect(members()).toEqual([[9, "ground", N]]);
    // The drop selects the piece it filled.
    expect(pressed(slot(N))).toBe(true);
    expect(queryId("tileset-autotiles-drag-ghost")).toBeNull();
  });

  it("clears a piece with its corner button, the Clear button and the Delete key, and moves with Arrow keys", () => {
    const { mergeKey, members } = renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
    // Every piece has a tile: the first is selected, and its corner Clear shows without any hover.
    expect(pressed(slot(E | S))).toBe(true);
    fireEvent.click(slotClear(E | S)!);
    expect(mergeKey()).toBe(`tileset:autotile:ground:clear:default:${E | S}`);
    expect(members().map(([id]) => id)).not.toContain(1);
    expect(pressed(slot(E | S))).toBe(true);
    expect(slotClear(E | S)).toBeNull();

    fireEvent.click(slot(E | S | W));
    fireEvent.click(byId("tileset-autotiles-selected-clear"));
    expect(mergeKey()).toBe(`tileset:autotile:ground:clear:default:${E | S | W}`);
    expect(members().map(([id]) => id)).not.toContain(2);

    slot(E | S | W).focus();
    fireEvent.keyDown(slot(E | S | W), { key: "ArrowRight" });
    expect(pressed(slot(S | W))).toBe(true);
    expect(document.activeElement).toBe(slot(S | W));
    fireEvent.keyDown(slot(S | W), { key: "ArrowDown" });
    expect(document.activeElement).toBe(slot(N | S | W));
    fireEvent.keyDown(slot(N | S | W), { key: "Delete" });
    expect(mergeKey()).toBe(`tileset:autotile:ground:clear:default:${N | S | W}`);
    expect(members().map(([id]) => id)).not.toContain(7);
  });

  it("acts on the first tap on touch: no piece reveals anything for a touch, and the selected piece always shows Clear", () => {
    renderWindow(sheet(4, 4, [GROUND_SIDES, WATER], sidesBlock()));
    expect(slotClear(E | S)).toBeTruthy();
    expect(slotClear(S | W)).toBeNull();
    // iOS treats a tap that reveals content on hover as a hover, and needs a second tap to press: a touch must change nothing.
    hover(slot(S | W), "touch");
    expect(slotClear(S | W)).toBeNull();
    hover(slot(S | W), "mouse");
    expect(slotClear(S | W)).toBeTruthy();
    hover(slot(S | W), "mouse", true);
    expect(slotClear(S | W)).toBeNull();
    // One tap selects, and the selected piece's Clear is there for the next tap.
    fireEvent.click(slot(S | W));
    expect(pressed(slot(S | W))).toBe(true);
    expect(slotClear(S | W)).toBeTruthy();
    expect(slotClear(E | S)).toBeNull();
    // Rows too: the selected row shows its actions, another row only under a hovering mouse
    // (`invisible` is the visibility itself here; jsdom applies no styles).
    const hidden = (id: string) => /\binvisible\b/.test(byId(`tileset-autotiles-actions-${id}`).className);
    expect(hidden("ground")).toBe(false);
    expect(hidden("water")).toBe(true);
    hover(row("water"), "touch");
    expect(hidden("water")).toBe(true);
    hover(row("water"), "mouse");
    expect(hidden("water")).toBe(false);
  });

  describe("block assignment", () => {
    it("assigns Main, then More Corners, from a standard Blob sheet in one undo step each", () => {
      const { onChange, mergeKey } = renderWindow(sheet(12, 4, [GROUND_BLOB]));
      layOutSheet(12, 4);
      const surface = byId("tileset-autotiles-sheet-surface");
      fireEvent.click(byId("tileset-autotiles-block-main"));
      expect(pressed(byId("tileset-autotiles-block-main"))).toBe(true);
      expect(byId("tileset-autotiles-block-main").getAttribute("aria-label")).toBe("Assign Main From a Block on the Sheet");
      expect(text("tileset-autotiles-sheet-hint")).toBe("Click the top-left tile of a 4 × 4 block.Esc");
      // The outline follows a hovering mouse, and keeps to the sheet.
      act(() => dispatchPointerEvent(surface, "pointermove", { pointerType: "mouse", clientX: 8, clientY: 8 }));
      expect(byId("tileset-autotiles-block-outline").dataset.anchor).toBe("1");
      expect(text("tileset-autotiles-block-outline")).toBe("Main · 16 pieces");
      act(() => dispatchPointerEvent(surface, "pointermove", { pointerType: "mouse", clientX: 168, clientY: 8 }));
      expect(text("tileset-autotiles-block-outline")).toBe("Main · 8 pieces");
      fireEvent.click(cell(1));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(mergeKey()).toBe("tileset:autotile:ground:block:default:main:1");
      expect(text("tileset-autotiles-group-main-count")).toBe("16 of 16");
      expect(pressed(byId("tileset-autotiles-block-main"))).toBe(false);
      expect(queryId("tileset-autotiles-block-outline")).toBeNull();

      fireEvent.click(byId("tileset-autotiles-block-more-corners"));
      expect(text("tileset-autotiles-sheet-hint")).toBe("Click the top-left tile of a 8 × 4 block.Esc");
      fireEvent.click(cell(5));
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(mergeKey()).toBe("tileset:autotile:ground:block:default:more-corners:5");
      expect(text("tileset-autotiles-group-inner-corners-count")).toBe("4 of 4");
      expect(text("tileset-autotiles-group-more-corners-count")).toBe("27 of 27 · Optional");
      expect(byId("tileset-autotiles-status-ground").dataset.ready).toBe("true");
    });

    it("assigns Inner Corners as a hole, and cancels with Escape or the button", () => {
      const { onChange, members } = renderWindow(sheet(6, 4, [GROUND_BLOB]));
      const button = byId("tileset-autotiles-block-inner-corners");
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "Escape" });
      expect(pressed(button)).toBe(false);
      fireEvent.click(button);
      fireEvent.click(button);
      expect(pressed(button)).toBe(false);
      fireEvent.click(button);
      fireEvent.click(cell(5));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(members()).toEqual([
        [5, "ground", TERRAIN_ALL & ~SE], [6, "ground", TERRAIN_ALL & ~SW],
        [11, "ground", TERRAIN_ALL & ~NE], [12, "ground", TERRAIN_ALL & ~NW],
      ]);
    });
  });

  describe("Preview", () => {
    const tileAt = (x: number, y: number) => previewCell(x, y).dataset.tileId;

    it("paints and erases a cell with a tap, with the pieces a Tilemap brush picks, and resets", () => {
      renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
      // The sample's top strip runs from column 2 to 7: left end (tile 13), middles (14), right end (15).
      expect([tileAt(2, 5), tileAt(3, 5), tileAt(7, 5)]).toEqual(["13", "14", "15"]);
      expect(text("tileset-autotiles-preview-status")).toBe("Every cell has its piece");
      fireEvent.click(previewCell(1, 5));
      expect(previewCell(1, 5).dataset.terrain).toBe("ground");
      expect([tileAt(1, 5), tileAt(2, 5)]).toEqual(["13", "14"]);
      fireEvent.click(previewCell(1, 5));
      expect(previewCell(1, 5).dataset.terrain).toBeUndefined();
      expect(tileAt(2, 5)).toBe("13");
      fireEvent.click(previewCell(2, 5));
      expect(tileAt(3, 5)).toBe("13");
      fireEvent.click(byId("tileset-autotiles-preview-reset"));
      expect(tileAt(2, 5)).toBe("13");
      expect(tileAt(3, 5)).toBe("14");
    });

    it("toggles a cell between the autotile and its border autotile in a border set", () => {
      renderWindow(sheet(4, 9, [{ ...GROUND_SIDES, borders: ["water"] }, WATER], {
        ...sidesBlock(),
        ...nextToWaterIsland(),
        33: { id: "water", mask: NESW },
      }));
      fireEvent.click(row("ground-water"));
      // The island's top-left faces Water: the set's own corner piece, tile 17. Water runs under the seam.
      expect(previewCell(2, 5).dataset).toMatchObject({ terrain: "ground", tileId: "17", border: "water" });
      expect(previewCell(1, 5).dataset).toMatchObject({ terrain: "water", tileId: "33" });
      fireEvent.click(previewCell(2, 5));
      expect(previewCell(2, 5).dataset.terrain).toBe("water");
      // The cell beside it now faces Water on its left: the set's top-left corner.
      expect(previewCell(3, 5).dataset).toMatchObject({ terrain: "ground", tileId: "17" });
      fireEvent.click(previewCell(2, 5));
      expect(previewCell(2, 5).dataset.terrain).toBe("ground");
      // Each set keeps its own preview.
      fireEvent.click(previewCell(5, 3));
      fireEvent.click(row("ground"));
      expect(previewCell(5, 3).dataset.terrain).toBeUndefined();
      fireEvent.click(row("ground-water"));
      expect(previewCell(5, 3).dataset.terrain).toBe("water");
    });

    it("marks cells that use a nearby piece and says how many", () => {
      // Every piece but the single (tile 16).
      const members = sidesBlock();
      delete members[16];
      renderWindow(sheet(4, 4, [GROUND_SIDES], members));
      expect(previewCell(9, 1).dataset.standIn).toBe("true");
      expect(previewCell(2, 5).dataset.standIn).toBeUndefined();
      expect(text("tileset-autotiles-preview-status")).toBe("1 cell uses a nearby piece");
      // The empty single is selected first: painting draws the closest piece, the bottom end (tile 4).
      expect(text("tileset-autotiles-selected-name")).toBe("Single");
      expect(text("tileset-autotiles-selected-tile")).toBe("No tile · painting uses Tile 4 instead");
      expect(tileAt(9, 1)).toBe("4");
      cleanup();

      renderWindow(sheet(4, 4, [GROUND_SIDES]));
      expect(text("tileset-autotiles-preview-status")).toBe("13 cells have no tile yet");
      expect(previewCell(2, 5).dataset).toMatchObject({ tileId: "0", standIn: "true" });
    });

    it("highlights every cell that wants the selected piece, before the piece has a tile too", () => {
      renderWindow(sheet(4, 4, [GROUND_BLOB]));
      expect(text("tileset-autotiles-selected-name")).toBe("Top-Left Corner");
      expect(text("tileset-autotiles-selected-tile")).toBe("No tile");
      // The island's top-left, and the bottom strip's left end, which continues past the preview's bottom edge.
      expect(pickedCells().sort()).toEqual(["1,0", "1,5"]);
      expect(text("tileset-autotiles-selected-where")).toBe("2 cells in the preview");
      fireEvent.click(slot(N | E | NE));
      expect(pickedCells().sort()).toEqual(["1,3", "2,2"]);
      expect(text("tileset-autotiles-selected-where")).toBe("2 cells in the preview");
      fireEvent.click(byId("tileset-autotiles-more-toggle"));
      fireEvent.click(slot(NESW));
      expect(text("tileset-autotiles-selected-name")).toBe("Notches Top Right, Bottom Right, Bottom Left, Top Left");
      expect(pickedCells()).toEqual([]);
      expect(text("tileset-autotiles-selected-where")).toBe("Not in the preview");
    });

    it("outlines the piece of a cell under a hovering mouse on the board", () => {
      renderWindow(sheet(4, 4, [GROUND_SIDES], sidesBlock()));
      hover(previewCell(9, 1), "touch");
      expect(slot(0).dataset.previewHover).toBeUndefined();
      hover(previewCell(9, 1), "mouse");
      expect(slot(0).dataset.previewHover).toBe("true");
    });

    it("selects the piece a cell uses from its menu, switching sets when it belongs to another", () => {
      renderWindow(sheet(4, 9, [{ ...GROUND_SIDES, borders: ["water"] }, WATER], {
        ...sidesBlock(),
        ...nextToWaterIsland(),
        33: { id: "water", mask: NESW },
      }));
      fireEvent.click(row("ground-water"));
      expect(pressed(slot(S))).toBe(true);
      fireEvent.contextMenu(previewCell(2, 5));
      fireEvent.click(screen.getByRole("menuitem", { name: "Select Piece" }));
      expect(current(row("ground-water"))).toBe(true);
      expect(pressed(slot(E | S))).toBe(true);
      // Water at the preview's top-left corner continues past both edges: Water's own fill.
      fireEvent.contextMenu(previewCell(0, 6));
      fireEvent.click(screen.getByRole("menuitem", { name: "Select Piece" }));
      expect(current(row("water"))).toBe(true);
      expect(text("tileset-autotiles-pieces-title")).toBe("Water");
      expect(pressed(slot(NESW))).toBe(true);
    });
  });

  it("renames from the menu and deletes an autotile with its tiles and other autotiles' sets next to it", () => {
    const { onChange, last, mergeKey } = renderWindow(sheet(4, 5, [GROUND_SIDES, { ...WATER, borders: ["ground"] }], {
      ...sidesBlock(),
      17: { id: "water", mask: 0, border: "ground" },
    }));
    expect(row("water-ground").textContent).toBe("Next To Ground");
    fireEvent.click(byId("tileset-autotiles-actions-ground"));
    fireEvent.click(byId("tileset-autotiles-rename"));
    const input = byId("tileset-autotiles-rename-ground");
    fireEvent.change(input, { target: { value: "Ledge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mergeKey()).toBe("tileset:autotile:ground:name");
    expect(last().terrains![0]).toEqual({ ...GROUND_SIDES, name: "Ledge" });
    expect(row("water-ground").textContent).toBe("Next To Ledge");

    fireEvent.click(byId("tileset-autotiles-actions-ground"));
    fireEvent.click(byId("tileset-autotiles-delete"));
    expect(byId("tileset-autotiles-delete-dialog").textContent).toContain("17 tiles leave");
    fireEvent.click(byId("tileset-autotiles-delete-confirm"));
    expect(mergeKey()).toBe("tileset:autotile:ground:delete");
    expect(last().terrains).toEqual([WATER]);
    expect(last().tiles.some((tile) => tile.terrain)).toBe(false);
    expect(current(row("water"))).toBe(true);
    expect(queryId("tileset-autotiles-row-water-ground")).toBeNull();

    // Without tiles to lose, Delete asks nothing.
    fireEvent.click(byId("tileset-autotiles-actions-water"));
    fireEvent.click(byId("tileset-autotiles-delete"));
    expect(queryId("tileset-autotiles-delete-dialog")).toBeNull();
    expect(last().terrains).toBeUndefined();
    expect(byId("tileset-autotiles-empty")).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
