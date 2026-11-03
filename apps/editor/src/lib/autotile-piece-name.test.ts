import { describe, expect, it } from "vitest";
import {
  AUTOTILE_PIECE_GROUPS,
  TERRAIN_ALL,
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
} from "@haptic/assets";
import { autotilePieceName } from "./autotile-piece-name";

const N = TERRAIN_N;
const NE = TERRAIN_NE;
const E = TERRAIN_E;
const SE = TERRAIN_SE;
const S = TERRAIN_S;
const SW = TERRAIN_SW;
const W = TERRAIN_W;
const NW = TERRAIN_NW;

describe("autotilePieceName", () => {
  it.each([
    [E | S | SE, "Top-left corner"],
    [E | S | W | SE | SW, "Top edge"],
    [S | W | SW, "Top-right corner"],
    [N | E | NE, "Bottom-left corner"],
    [N | E | S | NE | SE, "Left edge"],
    [TERRAIN_ALL, "Fill"],
    [E | W, "Row middle"],
    [N | S, "Column middle"],
    [E, "Left end"],
    [W, "Right end"],
    [S, "Top end"],
    [N, "Bottom end"],
    [0, "Single"],
    [TERRAIN_ALL & ~SE, "Inner corner, bottom right"],
    [TERRAIN_ALL & ~NW, "Inner corner, top left"],
    [TERRAIN_ALL & ~NE & ~SW, "Notches top right, bottom left"],
    [E | S | W | SW, "Top edge, notch bottom right"],
    [N | E | S, "Left edge, notch top right and bottom right"],
  ] as const)("names the Blob piece %i %s", (mask, name) => {
    expect(autotilePieceName(mask, "blob")).toBe(name);
  });

  it("never names notches for 4 Sides, whose pieces have no corners", () => {
    expect(autotilePieceName(N | E | S | W, "sides")).toBe("Fill");
    expect(autotilePieceName(N | E | S, "sides")).toBe("Left edge");
    expect(autotilePieceName(E | S, "sides")).toBe("Top-left corner");
  });

  it("gives every piece of each style its own name", () => {
    for (const style of ["sides", "blob"] as const) {
      const masks = AUTOTILE_PIECE_GROUPS[style].flatMap((group) => group.masks);
      expect(new Set(masks.map((mask) => autotilePieceName(mask, style))).size).toBe(masks.length);
    }
  });
});
