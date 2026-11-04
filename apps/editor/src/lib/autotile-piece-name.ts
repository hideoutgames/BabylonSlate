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
  [TERRAIN_N, "Top"],
  [TERRAIN_E, "Right"],
  [TERRAIN_S, "Bottom"],
  [TERRAIN_W, "Left"],
];

/** Each corner bit, the two sides it sits between, and its name. */
const CORNER_NAMES: ReadonlyArray<readonly [number, number, string]> = [
  [TERRAIN_NE, TERRAIN_N | TERRAIN_E, "Top Right"],
  [TERRAIN_SE, TERRAIN_S | TERRAIN_E, "Bottom Right"],
  [TERRAIN_SW, TERRAIN_S | TERRAIN_W, "Bottom Left"],
  [TERRAIN_NW, TERRAIN_N | TERRAIN_W, "Top Left"],
];

/**
 * A piece's Title Case name from the sides its art leaves open ("Top Edge",
 * "Top-Left Corner", "Row Middle", "Left End", "Single") and, for Blob, the
 * inner-corner notches it draws ("Inner Corner, Bottom Right"). `mask` is the
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
    return notches.length === 1 ? `Inner Corner, ${notches[0]}` : `Notches ${notches.join(", ")}`;
  }
  let base: string;
  if (open.length === 1) {
    base = `${open[0]![1]} Edge`;
  } else if (open.length === 2) {
    const vertical = openBits.includes(TERRAIN_N) ? "Top" : openBits.includes(TERRAIN_S) ? "Bottom" : "";
    const horizontal = openBits.includes(TERRAIN_W) ? "Left" : openBits.includes(TERRAIN_E) ? "Right" : "";
    base = vertical && horizontal
      ? `${vertical}-${horizontal} Corner`
      : openBits.includes(TERRAIN_N) ? "Row Middle" : "Column Middle";
  } else if (open.length === 3) {
    const joined = SIDE_NAMES.find(([bit]) => mask & bit)![0];
    base = joined === TERRAIN_E ? "Left End" : joined === TERRAIN_W ? "Right End" : joined === TERRAIN_S ? "Top End" : "Bottom End";
  } else {
    base = "Single";
  }
  return notches.length > 0 ? `${base}, Notch ${notches.join(" and ")}` : base;
}
