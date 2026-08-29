import { describe, expect, it } from "vitest";
import {
  clampOverlayMenuPosition,
  overlaySubmenuOrigin,
} from "./clamp-overlay-menu";

describe("clampOverlayMenuPosition", () => {
  it("keeps the pointer as the top-left origin when the panel fits", () => {
    expect(
      clampOverlayMenuPosition({
        x: 40,
        y: 50,
        width: 192,
        height: 120,
        viewportWidth: 800,
        viewportHeight: 600,
        margin: 8,
      }),
    ).toEqual({ x: 40, y: 50 });
  });

  it("shifts a bottom-right pointer so all edges stay in the viewport", () => {
    expect(
      clampOverlayMenuPosition({
        x: 780,
        y: 580,
        width: 192,
        height: 160,
        viewportWidth: 800,
        viewportHeight: 600,
        margin: 8,
      }),
    ).toEqual({ x: 600, y: 432 });
  });

  it("pins a taller-than-viewport menu to the margin", () => {
    expect(
      clampOverlayMenuPosition({
        x: 20,
        y: 20,
        width: 192,
        height: 900,
        viewportWidth: 800,
        viewportHeight: 600,
        margin: 8,
      }),
    ).toEqual({ x: 20, y: 8 });
  });

  it("keeps a menu inside all safe-area edges", () => {
    expect(
      clampOverlayMenuPosition({
        x: 780,
        y: 580,
        width: 192,
        height: 160,
        viewportWidth: 800,
        viewportHeight: 600,
        margin: 8,
        insets: { top: 44, right: 24, bottom: 20, left: 24 },
      }),
    ).toEqual({ x: 576, y: 412 });
  });

  it("pins zero insets to the existing clamp behavior", () => {
    expect(
      clampOverlayMenuPosition({
        x: 780,
        y: 580,
        width: 192,
        height: 160,
        viewportWidth: 800,
        viewportHeight: 600,
        margin: 8,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      }),
    ).toEqual({ x: 600, y: 432 });
  });
});

describe("overlaySubmenuOrigin", () => {
  it("opens to the right of the parent when there is room", () => {
    expect(
      overlaySubmenuOrigin({
        parentX: 40,
        parentY: 50,
        parentWidth: 192,
        submenuWidth: 192,
        viewportWidth: 800,
        margin: 8,
      }),
    ).toEqual({ x: 232, y: 50 });
  });

  it("opens to the left of the parent when the right side overflows", () => {
    expect(
      overlaySubmenuOrigin({
        parentX: 620,
        parentY: 40,
        parentWidth: 192,
        submenuWidth: 192,
        viewportWidth: 800,
        margin: 8,
      }),
    ).toEqual({ x: 428, y: 40 });
  });

  it("keeps a flipped submenu outside the left safe-area edge", () => {
    expect(
      overlaySubmenuOrigin({
        parentX: 100,
        parentY: 50,
        parentWidth: 192,
        submenuWidth: 192,
        viewportWidth: 250,
        margin: 8,
        insets: { left: 24 },
      }),
    ).toEqual({ x: 32, y: 50 });
  });

  it("keeps a right-opening submenu outside the right safe-area edge", () => {
    expect(
      overlaySubmenuOrigin({
        parentX: 560,
        parentY: 50,
        parentWidth: 192,
        submenuWidth: 192,
        viewportWidth: 800,
        margin: 8,
        insets: { right: 24 },
      }),
    ).toEqual({ x: 360, y: 50 });
  });
});
