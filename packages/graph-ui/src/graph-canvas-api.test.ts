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

  it("returns a no-op api when the element is missing", () => {
    const api = createGraphCanvasDropApi(null, () => ({ x: 0, y: 0 }));
    expect(api.containsClientPoint(10, 10)).toBe(false);
    expect(api.clientToFlow(10, 10)).toEqual({ x: 0, y: 0 });
  });
});
