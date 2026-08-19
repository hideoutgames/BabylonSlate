import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_RESIZE_HOLD_MS,
  createCanvasResizeGuard,
} from "./canvas-resize-guard";

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

  it("holds render across rapid size changes and resumes after the hold", () => {
    expect(CANVAS_RESIZE_HOLD_MS).toBe(80);
    const resize = vi.fn();
    const onHoldChange = vi.fn();
    const pending = new Map<number, () => void>();
    let nextId = 1;
    const apply = createCanvasResizeGuard(resize, {
      onHoldChange,
      schedule: (fn) => {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      },
      cancel: (id) => {
        pending.delete(id as number);
      },
    });
    apply({ clientWidth: 640, clientHeight: 360 });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(onHoldChange).toHaveBeenCalledTimes(1);
    expect(onHoldChange).toHaveBeenLastCalledWith(true);

    apply({ clientWidth: 641, clientHeight: 360 });
    expect(resize).toHaveBeenCalledTimes(2);
    expect(onHoldChange.mock.calls).toEqual([[true]]);
    expect(pending.size).toBe(1);

    for (const fn of pending.values()) fn();
    pending.clear();
    expect(onHoldChange).toHaveBeenLastCalledWith(false);
    expect(resize).toHaveBeenCalledTimes(3);
    apply.dispose();
  });

  it("cancels a pending resume when disposed", () => {
    const resize = vi.fn();
    const onHoldChange = vi.fn();
    const pending = new Map<number, () => void>();
    let nextId = 1;
    const apply = createCanvasResizeGuard(resize, {
      onHoldChange,
      schedule: (fn) => {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      },
      cancel: (id) => {
        pending.delete(id as number);
      },
    });
    apply({ clientWidth: 640, clientHeight: 360 });
    expect(pending.size).toBe(1);
    apply.dispose();
    expect(pending.size).toBe(0);
    expect(onHoldChange.mock.calls).toEqual([[true]]);
    expect(resize).toHaveBeenCalledTimes(1);
  });
});
