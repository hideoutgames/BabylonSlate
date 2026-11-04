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
    [E | S | SE, "Top-Left Corner"],
    [E | S | W | SE | SW, "Top Edge"],
    [S | W | SW, "Top-Right Corner"],
    [N | E | NE, "Bottom-Left Corner"],
    [N | E | S | NE | SE, "Left Edge"],
    [TERRAIN_ALL, "Fill"],
    [E | W, "Row Middle"],
    [N | S, "Column Middle"],
    [E, "Left End"],
    [W, "Right End"],
    [S, "Top End"],
    [N, "Bottom End"],
    [0, "Single"],
    [TERRAIN_ALL & ~SE, "Inner Corner, Bottom Right"],
    [TERRAIN_ALL & ~NW, "Inner Corner, Top Left"],
    [TERRAIN_ALL & ~NE & ~SW, "Notches Top Right, Bottom Left"],
    [E | S | W | SW, "Top Edge, Notch Bottom Right"],
    [N | E | S, "Left Edge, Notch Top Right and Bottom Right"],
  ] as const)("names the Blob piece %i %s", (mask, name) => {
    expect(autotilePieceName(mask, "blob")).toBe(name);
  });

  it("never names notches for 4 Sides, whose pieces have no corners", () => {
    expect(autotilePieceName(N | E | S | W, "sides")).toBe("Fill");
    expect(autotilePieceName(N | E | S, "sides")).toBe("Left Edge");
    expect(autotilePieceName(E | S, "sides")).toBe("Top-Left Corner");
  });

  it("gives every piece of each style its own name", () => {
    for (const style of ["sides", "blob"] as const) {
      const masks = AUTOTILE_PIECE_GROUPS[style].flatMap((group) => group.masks);
      expect(new Set(masks.map((mask) => autotilePieceName(mask, style))).size).toBe(masks.length);
    }
  });
});
