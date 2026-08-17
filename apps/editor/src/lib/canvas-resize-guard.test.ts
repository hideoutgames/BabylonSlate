import { describe, expect, it, vi } from "vitest";
import { createCanvasResizeGuard } from "./canvas-resize-guard";

describe("createCanvasResizeGuard", () => {
  it("resizes once for a sized canvas and skips an unchanged integer size", () => {
    const resize = vi.fn();
    const apply = createCanvasResizeGuard(resize);
    const canvas = { clientWidth: 640.4, clientHeight: 360.9 };
    apply(canvas);
    apply(canvas);
    apply({ clientWidth: 640.1, clientHeight: 360.2 });
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("resizes again when the integer size changes", () => {
    const resize = vi.fn();
    const apply = createCanvasResizeGuard(resize);
    apply({ clientWidth: 640, clientHeight: 360 });
    apply({ clientWidth: 800, clientHeight: 360 });
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("skips a zero-size canvas", () => {
    const resize = vi.fn();
    const apply = createCanvasResizeGuard(resize);
    apply({ clientWidth: 0, clientHeight: 360 });
    apply({ clientWidth: 640, clientHeight: 0 });
    expect(resize).not.toHaveBeenCalled();
  });
});
