import { describe, expect, it } from "vitest";
import { centeredView, contentToView, fitScale, pinchView, viewToContent, zoomViewAbout } from "./pan-zoom-model";

describe("pan-zoom model", () => {
  const surface = { width: 400, height: 300 };
  const content = { width: 200, height: 100 };

  it("fits and centres content inside the surface less its inset", () => {
    const scale = fitScale(content, surface, 50);
    expect(scale).toBe(1.5);
    expect(centeredView(content, surface, scale)).toEqual({ scale: 1.5, x: 50, y: 75 });
  });

  it("keeps the content point under the pivot fixed while zooming", () => {
    const view = centeredView(content, surface, 1);
    const pivot = { x: 130, y: 170 };
    const before = viewToContent(view, pivot);
    const zoomed = zoomViewAbout(view, 3, pivot);
    expect(zoomed.scale).toBe(3);
    const after = contentToView(zoomed, before);
    expect(after.x).toBeCloseTo(pivot.x);
    expect(after.y).toBeCloseTo(pivot.y);
  });

  it("clamps zoom to the limits", () => {
    const view = centeredView(content, surface, 1);
    expect(zoomViewAbout(view, 1000, { x: 0, y: 0 }, { minScale: 0.5, maxScale: 8 }).scale).toBe(8);
  });

  it("measures a pinch from where the fingers went down, so it does not drift", () => {
    const origin = { view: centeredView(content, surface, 1), mid: { x: 200, y: 150 }, spread: 100 };
    const once = pinchView(origin, { x: 220, y: 150 }, 200);
    const again = pinchView(origin, { x: 220, y: 150 }, 200);
    expect(once).toEqual(again);
    expect(once.scale).toBe(2);
    // The content under the starting midpoint follows the fingers.
    const anchored = contentToView(once, viewToContent(origin.view, origin.mid));
    expect(anchored.x).toBeCloseTo(220);
    expect(anchored.y).toBeCloseTo(150);
  });
});
