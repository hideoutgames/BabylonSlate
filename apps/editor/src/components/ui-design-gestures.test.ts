import { describe, expect, it } from "vitest";
import { pinLayout } from "@babylonslate/ui-runtime";
import {
  anchorPointsToScreen,
  applyWidgetDragOffset,
  canvasDeltaToLayoutDelta,
  centeredFitView,
  clampDesignZoom,
  designRectToScreen,
  passedDragThreshold,
  pivotToScreen,
  previewScaleToFit,
  resizeHandleRects,
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

  it("fits the canvas inside the viewport with padding and centers pan", () => {
    const { previewScale, view } = centeredFitView(
      { width: 400, height: 300 },
      { width: 800, height: 600 },
    );
    expect(previewScale).toBeCloseTo((300 - 48) / 600);
    expect(view.zoom).toBe(1);
    expect(view.panY).toBeCloseTo(24);
  });

  it("maps a design GUI rect into screen space", () => {
    const screen = designRectToScreen(
      { x: 10, y: 20, width: 100, height: 50 },
      { zoom: 2, panX: 5, panY: 7 },
      0.5,
    );
    expect(screen).toEqual({ x: 15, y: 27, width: 100, height: 50 });
  });

  it("maps pivot and unique anchor corners into screen space", () => {
    const view = { zoom: 1, panX: 0, panY: 0 };
    expect(
      pivotToScreen({ x: 0, y: 0, width: 100, height: 40 }, { x: 0.5, y: 0 }, view, 1),
    ).toEqual({ x: 50, y: 40 });
    expect(
      anchorPointsToScreen(
        { x: 0, y: 0, width: 200, height: 100 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        view,
        1,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]);
  });

  it("falls back to a readable scale when the viewport is unmeasured", () => {
    expect(previewScaleToFit({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toBeCloseTo(
      640 / 1920,
    );
  });

  it("places 44px resize handles around a screen rect", () => {
    const handles = resizeHandleRects({ x: 100, y: 50, width: 200, height: 80 });
    expect(handles.se.width).toBe(44);
    expect(handles.se.height).toBe(44);
    expect(handles.nw.x).toBe(100 - 22);
    expect(handles.nw.y).toBe(50 - 22);
    expect(handles.e.x).toBe(100 + 200 - 22);
    expect(handles.e.y).toBe(50 + 40 - 22);
  });

  it("arms a drag only after the movement threshold", () => {
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });
});
