import {
  TERRAIN_E,
  TERRAIN_N,
  TERRAIN_NE,
  TERRAIN_NW,
  TERRAIN_S,
  TERRAIN_SE,
  TERRAIN_SW,
  TERRAIN_W,
  type TilesetTerrainStyle,
} from "@haptic/assets";

const SIDE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [TERRAIN_N, "top"],
  [TERRAIN_E, "right"],
  [TERRAIN_S, "bottom"],
  [TERRAIN_W, "left"],
];

/** Each corner bit, the two sides it sits between, and its name. */
const CORNER_NAMES: ReadonlyArray<readonly [number, number, string]> = [
  [TERRAIN_NE, TERRAIN_N | TERRAIN_E, "top right"],
  [TERRAIN_SE, TERRAIN_S | TERRAIN_E, "bottom right"],
  [TERRAIN_SW, TERRAIN_S | TERRAIN_W, "bottom left"],
  [TERRAIN_NW, TERRAIN_N | TERRAIN_W, "top left"],
];

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A piece's plain name from the sides its art leaves open ("Top edge",
 * "Top-left corner", "Row middle", "Left end", "Single") and, for Blob, the
 * inner-corner notches it draws ("Inner corner, bottom right"). `mask` is the
 * piece's canonical mask: the neighbours its art continues into.
 */
export function autotilePieceName(mask: number, style: TilesetTerrainStyle): string {
  const open = SIDE_NAMES.filter(([bit]) => !(mask & bit));
  const notches = style === "blob"
    ? CORNER_NAMES.filter(([bit, sides]) => (mask & sides) === sides && !(mask & bit)).map(([, , name]) => name)
    : [];
  const openBits = open.map(([bit]) => bit);
  if (open.length === 0) {
    if (notches.length === 0) return "Fill";
    return notches.length === 1 ? `Inner corner, ${notches[0]}` : `Notches ${notches.join(", ")}`;
  }
  let base: string;
  if (open.length === 1) {
    base = `${capitalized(open[0]![1])} edge`;
  } else if (open.length === 2) {
    const vertical = openBits.includes(TERRAIN_N) ? "Top" : openBits.includes(TERRAIN_S) ? "Bottom" : "";
    const horizontal = openBits.includes(TERRAIN_W) ? "left" : openBits.includes(TERRAIN_E) ? "right" : "";
    base = vertical && horizontal
      ? `${vertical}-${horizontal} corner`
      : openBits.includes(TERRAIN_N) ? "Row middle" : "Column middle";
  } else if (open.length === 3) {
    const joined = SIDE_NAMES.find(([bit]) => mask & bit)![0];
    base = joined === TERRAIN_E ? "Left end" : joined === TERRAIN_W ? "Right end" : joined === TERRAIN_S ? "Top end" : "Bottom end";
  } else {
    base = "Single";
  }
  return notches.length > 0 ? `${base}, notch ${notches.join(" and ")}` : base;
}
