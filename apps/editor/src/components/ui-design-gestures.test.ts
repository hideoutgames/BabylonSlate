import { describe, expect, it } from "vitest";
import { pinLayout } from "@babylonslate/ui-runtime";
import {
  applyWidgetDragOffset,
  canvasDeltaToLayoutDelta,
  centeredFitView,
  clampDesignZoom,
  designRectToBitmap,
  designRectToScreen,
  passedDragThreshold,
  pivotToScreen,
  previewScaleToFit,
  resizeHandleRects,
  designerControlHitRect,
  designerGestureAt,
  UI_DESIGN_HANDLE_HIT_SIZE_PX,
  UI_DESIGN_HANDLE_VISUAL_SIZE_PX,
  uiDesignStrokeMergeKey,
  zoomAtPoint,
} from "./ui-design-gestures";

describe("ui-design-gestures", () => {
  it("translates left/top by the layout delta without flipping Y", () => {
    const layout = pinLayout("left", "bottom", 160, 160, 40, 0);
    const next = applyWidgetDragOffset(layout, { x: 10, y: 20 });
    expect(next.horizontalAlignment).toBe("left");
    expect(next.verticalAlignment).toBe("bottom");
    expect(next.width).toBe(160);
    expect(next.left).toBe(50);
    expect(next.top).toBe(20);
  });

  it("scales design-space rects onto the bitmap from the origin", () => {
    expect(designRectToBitmap({ x: 10, y: 20, width: 100, height: 40 }, 0.5)).toEqual({
      x: 5,
      y: 10,
      width: 50,
      height: 20,
    });
  });

  it("converts screen deltas into layout space at the view scale", () => {
    expect(canvasDeltaToLayoutDelta({ x: 45, y: 18 }, 0.45)).toEqual({
      x: 100,
      y: 40,
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

  it("maps transform center into screen space (Y-down)", () => {
    const view = { zoom: 1, panX: 0, panY: 0 };
    expect(
      pivotToScreen({ x: 0, y: 0, width: 100, height: 40 }, { x: 0.5, y: 0 }, view, 1),
    ).toEqual({ x: 50, y: 0 });
    expect(
      pivotToScreen({ x: 0, y: 0, width: 100, height: 40 }, { x: 0.5, y: 1 }, view, 1),
    ).toEqual({ x: 50, y: 40 });
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

  it("keeps compact visual handles separate from 44px touch hits", () => {
    expect(UI_DESIGN_HANDLE_HIT_SIZE_PX).toBe(44);
    expect(UI_DESIGN_HANDLE_VISUAL_SIZE_PX).toBeGreaterThanOrEqual(12);
    expect(UI_DESIGN_HANDLE_VISUAL_SIZE_PX).toBeLessThanOrEqual(14);
    const visual = resizeHandleRects(
      { x: 100, y: 50, width: 200, height: 80 },
      UI_DESIGN_HANDLE_VISUAL_SIZE_PX,
    );
    expect(visual.se.width).toBe(UI_DESIGN_HANDLE_VISUAL_SIZE_PX);
    expect(visual.se.height).toBe(UI_DESIGN_HANDLE_VISUAL_SIZE_PX);
  });

  it("covers the complete device frame when the root has no live measure", () => {
    const viewport = { width: 400, height: 300 };
    const bitmapScale = Math.min(400 / 1920, 300 / 1080);
    expect(
      designerControlHitRect(
        { id: "canvas", kind: "Canvas", guiRect: { x: 0, y: 0, width: 1920, height: 1080 } },
        undefined,
        viewport,
        bitmapScale,
        "canvas",
      ),
    ).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("does not stretch a nested Canvas to the device frame", () => {
    expect(
      designerControlHitRect(
        { id: "chip/canvas", kind: "Canvas", guiRect: { x: 10, y: 20, width: 80, height: 40 } },
        undefined,
        { width: 400, height: 300 },
        1,
        "canvas",
      ),
    ).toEqual({ x: 10, y: 20, width: 80, height: 40 });
  });

  it("keeps bitmap fallback for unmeasured child widgets", () => {
    expect(
      designerControlHitRect(
        { id: "btn", kind: "Button", guiRect: { x: 10, y: 20, width: 100, height: 40 } },
        undefined,
        { width: 400, height: 300 },
        0.5,
        "canvas",
      ),
    ).toEqual({ x: 5, y: 10, width: 50, height: 20 });
  });

  it("treats the center of a small widget as move, not overlapping resize", () => {
    const screen = { x: 100, y: 100, width: 160, height: 36 };
    expect(
      designerGestureAt({ x: 180, y: 118 }, screen),
    ).toBe("move");
    expect(
      designerGestureAt({ x: 100 + 160, y: 100 + 36 }, screen),
    ).toBe("se");
  });

  it("arms a drag only after the movement threshold", () => {
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });
});
