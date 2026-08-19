import { describe, expect, it } from "vitest";
import { designScale, pinLayout } from "@babylonslate/ui-runtime";
import {
  applyWidgetDragOffset,
  canvasDeltaToLayoutDelta,
  designerLayoutViewScale,
  centeredFitView,
  clampDesignZoom,
  designRectToBitmap,
  designRectToScreen,
  passedDragThreshold,
  pivotToScreen,
  previewScaleToFit,
  resizeHandleRects,
  resizeHandleHitRects,
  designerControlHitRect,
  designerGestureAt,
  frameRectView,
  UI_DESIGN_HANDLE_HIT_SIZE_PX,
  UI_DESIGN_HANDLE_VISUAL_SIZE_PX,
  uiDesignStrokeMergeKey,
  uiDesignerCanvasFitKey,
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

  it("scales percent left/top drags by the parent size", () => {
    const layout = pinLayout("left", "top", 80, 32, 10, 20);
    layout.leftUnit = "percent";
    layout.topUnit = "percent";
    const next = applyWidgetDragOffset(
      layout,
      { x: 40, y: 30 },
      { width: 200, height: 100 },
    );
    expect(next.left).toBe(30);
    expect(next.top).toBe(50);
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

  it("maps device-bitmap drags into project design pixels", () => {
    const bitmap = { width: 390, height: 844 };
    const designResolution = { width: 1920, height: 1080 };
    const viewScale = designerLayoutViewScale({
      previewScale: 1,
      zoom: 1,
      bitmap,
      designResolution,
      scaleRule: "shortestSide",
    });
    const adtScale = designScale(bitmap, designResolution, "shortestSide");
    const delta = canvasDeltaToLayoutDelta({ x: adtScale, y: 0 }, viewScale);
    expect(delta.x).toBeCloseTo(1);
    expect(delta.y).toBe(0);
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

  it("places 44px resize hits fully outside the widget", () => {
    const screen = { x: 100, y: 50, width: 200, height: 80 };
    const hits = resizeHandleHitRects(screen);
    expect(hits.se).toEqual({ x: 300, y: 130, width: 44, height: 44 });
    expect(hits.nw).toEqual({ x: 56, y: 6, width: 44, height: 44 });
    expect(hits.n.y).toBe(6);
    expect(hits.e.x).toBe(300);
    expect(hits.w.x).toBe(56);
    expect(hits.s.y).toBe(130);
  });

  it("places compact visual handles on the widget corners", () => {
    const visual = resizeHandleRects(
      { x: 100, y: 50, width: 200, height: 80 },
      UI_DESIGN_HANDLE_VISUAL_SIZE_PX,
    );
    expect(visual.se.width).toBe(UI_DESIGN_HANDLE_VISUAL_SIZE_PX);
    expect(visual.nw.x).toBe(100 - UI_DESIGN_HANDLE_VISUAL_SIZE_PX / 2);
  });

  it("keys Fit to the device canvas, not the dock panel size", () => {
    expect(
      uiDesignerCanvasFitKey("desktop-16-9", { width: 1920, height: 1080 }),
    ).toBe("desktop-16-9:1920x1080");
  });

  it("frames a selected widget into the viewport without using Fit zoom 1", () => {
    const view = frameRectView(
      { width: 400, height: 300 },
      { x: 0, y: 0, width: 160, height: 36 },
      1,
    );
    expect(view.zoom).toBeGreaterThan(1);
    expect(view.panX + 80 * view.zoom).toBeCloseTo(200);
    expect(view.panY + 18 * view.zoom).toBeCloseTo(150);
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
    expect(
      designerControlHitRect(
        { id: "canvas", kind: "Canvas", guiRect: { x: 0, y: 0, width: 400, height: 300 } },
        undefined,
        viewport,
        1,
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

  it("treats a preview-scaled widget smaller than the visual inset as move", () => {
    const screen = { x: 100, y: 100, width: 10, height: 10 };
    expect(designerGestureAt({ x: 105, y: 105 }, screen)).toBe("move");
    expect(designerGestureAt({ x: 90, y: 90 }, screen)).toBe("nw");
  });

  it("arms a drag only after the movement threshold", () => {
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });
});
