import { describe, expect, it } from "vitest";
import { pinLayout } from "@babylonslate/ui-runtime";
import {
  applyWidgetDragOffset,
  canvasDeltaToLayoutDelta,
  clampDesignZoom,
  uiDesignStrokeMergeKey,
  zoomAtPoint,
} from "./ui-design-gestures";

describe("ui-design-gestures", () => {
  it("keeps anchors and translates both offsets by the layout delta", () => {
    const layout = pinLayout({ x: 0.12, y: 0.18 }, { x: 160, y: 160 });
    const next = applyWidgetDragOffset(layout, { x: 10, y: -20 });
    expect(next.anchorMin).toEqual(layout.anchorMin);
    expect(next.anchorMax).toEqual(layout.anchorMax);
    expect(next.pivot).toEqual(layout.pivot);
    expect(next.offsetMin).toEqual({
      x: layout.offsetMin.x + 10,
      y: layout.offsetMin.y - 20,
    });
    expect(next.offsetMax).toEqual({
      x: layout.offsetMax.x + 10,
      y: layout.offsetMax.y - 20,
    });
  });

  it("converts screen-down deltas into layout Y-up at the view scale", () => {
    expect(canvasDeltaToLayoutDelta({ x: 45, y: 18 }, 0.45)).toEqual({
      x: 100,
      y: -40,
    });
  });

  it("clamps designer zoom", () => {
    expect(clampDesignZoom(0.01)).toBe(0.25);
    expect(clampDesignZoom(20)).toBe(8);
    expect(clampDesignZoom(1)).toBe(1);
  });

  it("keeps the pointer over the same canvas point when zooming", () => {
    const next = zoomAtPoint(
      { zoom: 1, panX: 0, panY: 0 },
      2,
      { x: 100, y: 40 },
    );
    expect(next.zoom).toBe(2);
    expect(next.panX).toBe(-100);
    expect(next.panY).toBe(-40);
  });

  it("uses one undo merge key per drag stroke", () => {
    expect(uiDesignStrokeMergeKey("abc")).toBe("ui-design-stroke:abc");
  });
});
