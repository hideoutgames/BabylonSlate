import { describe, expect, it, vi } from "vitest";
import { createGraphCanvasDropApi } from "./graph-canvas-api";

describe("createGraphCanvasDropApi", () => {
  it("maps client points inside the element and converts to flow space", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () =>
      ({
        left: 40,
        top: 80,
        right: 240,
        bottom: 280,
        width: 200,
        height: 200,
        x: 40,
        y: 80,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const clientToFlow = vi.fn((point: { x: number; y: number }) => ({
      x: point.x - 40,
      y: point.y - 80,
    }));
    const api = createGraphCanvasDropApi(element, clientToFlow);
    expect(api.containsClientPoint(40, 80)).toBe(true);
    expect(api.containsClientPoint(240, 280)).toBe(true);
    expect(api.containsClientPoint(39, 80)).toBe(false);
    expect(api.clientToFlow(90, 140)).toEqual({ x: 50, y: 60 });
  });

  it("refuses points over chrome drawn on the canvas, such as the toolbar", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-graph-overlay", "");
    toolbar.getBoundingClientRect = () =>
      ({ left: 150, top: 8, right: 250, bottom: 40, width: 100, height: 32 }) as DOMRect;
    element.appendChild(toolbar);
    const api = createGraphCanvasDropApi(element, (point) => point);
    expect(api.containsClientPoint(200, 20)).toBe(false);
    expect(api.containsClientPoint(200, 60)).toBe(true);
  });

  it("returns a no-op api when the element is missing", () => {
    const api = createGraphCanvasDropApi(null, () => ({ x: 0, y: 0 }));
    expect(api.containsClientPoint(10, 10)).toBe(false);
    expect(api.clientToFlow(10, 10)).toEqual({ x: 0, y: 0 });
  });
});
