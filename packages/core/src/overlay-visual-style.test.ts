import { expect, it } from "vitest";
import { parseOverlayVisualStyle } from "./overlay-visual-style";

it("normalizes graph colors and malformed authored channels without discarding valid HDR tint", () => {
  expect(parseOverlayVisualStyle({ opacity: 1.5, tint: { x: Infinity, y: -0.3, z: 2, w: -1 } })).toEqual({ opacity: 1, tint: [1, 0, 2, 0] });
  expect(parseOverlayVisualStyle({ opacity: NaN, tint: { r: 0.2, g: 0.4, b: 0.8, a: 0.5 } })).toEqual({ opacity: 1, tint: [0.2, 0.4, 0.8, 0.5] });
  const tint = [0.1, 0.2, 0.3];
  const style = parseOverlayVisualStyle({ opacity: 0.25, tint });
  tint[0] = 10;
  expect(style).toEqual({ opacity: 0.25, tint: [0.1, 0.2, 0.3, 1] });
});
