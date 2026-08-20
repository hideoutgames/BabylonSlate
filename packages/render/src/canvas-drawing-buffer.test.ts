import { describe, expect, it } from "vitest";
import { snapCanvasDrawingBuffer } from "./canvas-drawing-buffer";

describe("snapCanvasDrawingBuffer", () => {
  it("assigns integer CSS pixels onto the drawing buffer", () => {
    const canvas = { clientWidth: 800.6, clientHeight: 360.2, width: 256, height: 256 };
    expect(snapCanvasDrawingBuffer(canvas)).toEqual({ width: 800, height: 360 });
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(360);
  });

  it("uses a 1x1 floor when the canvas has no layout size", () => {
    const canvas = { clientWidth: 0, clientHeight: 0, width: 64, height: 32 };
    expect(snapCanvasDrawingBuffer(canvas)).toEqual({ width: 1, height: 1 });
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });
});
