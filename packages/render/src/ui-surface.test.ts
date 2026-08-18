import { describe, expect, it, vi } from "vitest";
import type { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import {
  attachAdtCanvasPointers,
  attachFullscreenGuiPointerMoves,
  isHardUiPresentFailure,
  presentAdtToCanvas,
  blitIfUnfrozen,
} from "./ui-surface";

function fakeAdt(
  source: { canvas: unknown } | null,
  size: { width: number; height: number } = { width: 8, height: 8 },
): AdvancedDynamicTexture {
  return {
    _checkUpdate: vi.fn(),
    getContext: () => source,
    getSize: () => size,
    markAsDirty: vi.fn(),
  } as unknown as AdvancedDynamicTexture;
}

describe("presentAdtToCanvas", () => {
  it("throws when the destination canvas has no 2d context", () => {
    const canvas = {
      getContext: () => null,
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    expect(() => presentAdtToCanvas(fakeAdt({ canvas: {} }), canvas)).toThrow(
      /2d context/i,
    );
  });

  it("retries layout then throws when the ADT backing canvas is missing", () => {
    const adt = fakeAdt(null);
    const canvas = {
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      }),
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    expect(() => presentAdtToCanvas(adt, canvas)).toThrow(/backing store/i);
    expect(adt._checkUpdate).toHaveBeenCalledTimes(2);
  });

  it("clears and copies when both contexts exist", () => {
    const sourceCanvas = { id: "adt" };
    const clearRect = vi.fn();
    const drawImage = vi.fn();
    const canvas = {
      getContext: () => ({ clearRect, drawImage }),
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    presentAdtToCanvas(fakeAdt({ canvas: sourceCanvas }), canvas);
    expect(clearRect).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(sourceCanvas, 0, 0);
  });

  it("disables invalidate-rect so an external blit redraws the complete interface", () => {
    const order: string[] = [];
    let invalidateRect = true;
    const adt = {
      useInvalidateRectOptimization: true,
      _checkUpdate: vi.fn(() => {
        order.push(`check:${invalidateRect ? "partial" : "full"}`);
      }),
      markAsDirty: vi.fn(() => {
        order.push("dirty");
      }),
      getContext: () => ({ canvas: { id: "adt" } }),
      getSize: () => ({ width: 8, height: 8 }),
    } as unknown as AdvancedDynamicTexture;
    Object.defineProperty(adt, "useInvalidateRectOptimization", {
      get: () => invalidateRect,
      set: (value: boolean) => {
        invalidateRect = value;
        order.push(`opt:${value}`);
      },
    });
    const canvas = {
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      }),
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    presentAdtToCanvas(adt, canvas);
    expect(adt.useInvalidateRectOptimization).toBe(false);
    expect(order.indexOf("opt:false")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("opt:false")).toBeLessThan(
      order.findIndex((step) => step.startsWith("check:")),
    );
    expect(order).toContain("check:full");
  });

  it("does not reset destination bitmap size until the ADT has fully redrawn", () => {
    let checkCalled = false;
    const widthSets: number[] = [];
    const adt = {
      useInvalidateRectOptimization: false,
      markAsDirty: vi.fn(),
      _checkUpdate: vi.fn(() => {
        checkCalled = true;
      }),
      getContext: () => ({ canvas: { id: "adt" } }),
      getSize: () => ({ width: 16, height: 8 }),
    } as unknown as AdvancedDynamicTexture;
    const canvas = {
      _width: 0,
      _height: 0,
      get width() {
        return this._width;
      },
      set width(value: number) {
        if (!checkCalled) {
          throw new Error("resized destination before ADT redraw");
        }
        widthSets.push(value);
        this._width = value;
      },
      get height() {
        return this._height;
      },
      set height(value: number) {
        if (!checkCalled) {
          throw new Error("resized destination before ADT redraw");
        }
        this._height = value;
      },
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;
    presentAdtToCanvas(adt, canvas);
    expect(widthSets).toEqual([16]);
  });

  it("does not reassign matching canvas dimensions (assigning width clears the bitmap)", () => {
    const adt = fakeAdt({ canvas: { id: "adt" } }, { width: 8, height: 8 });
    let widthAssigns = 0;
    const canvas = {
      _width: 8,
      _height: 8,
      get width() {
        return this._width;
      },
      set width(value: number) {
        widthAssigns += 1;
        this._width = value;
      },
      get height() {
        return this._height;
      },
      set height(value: number) {
        this._height = value;
      },
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;
    presentAdtToCanvas(adt, canvas);
    expect(widthAssigns).toBe(0);
  });

  it("skips the blit when the ADT size is 0 instead of throwing", () => {
    const clearRect = vi.fn();
    const drawImage = vi.fn();
    const canvas = {
      getContext: () => ({ clearRect, drawImage }),
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    expect(() =>
      presentAdtToCanvas(
        fakeAdt({ canvas: {} }, { width: 0, height: 0 }),
        canvas,
      ),
    ).not.toThrow();
    expect(drawImage).not.toHaveBeenCalled();
    expect(clearRect).not.toHaveBeenCalled();
  });
});

describe("blitIfUnfrozen", () => {
  it("runs the blit when the surface is not frozen", () => {
    const blit = vi.fn();
    blitIfUnfrozen(false, blit);
    expect(blit).toHaveBeenCalledTimes(1);
  });

  it("skips the blit when the surface is frozen", () => {
    const blit = vi.fn();
    blitIfUnfrozen(true, blit);
    expect(blit).not.toHaveBeenCalled();
  });
});

describe("isHardUiPresentFailure", () => {
  it("treats a missing 2d context or ADT backing store as a hard failure", () => {
    expect(
      isHardUiPresentFailure(new Error("Designer canvas has no 2d context for ADT blit")),
    ).toBe(true);
    expect(isHardUiPresentFailure(new Error("ADT backing store is missing"))).toBe(
      true,
    );
    expect(isHardUiPresentFailure(new Error("standalone ADT failed"))).toBe(false);
    expect(isHardUiPresentFailure(new Error("ADT blit size is 0"))).toBe(false);
    expect(isHardUiPresentFailure(null)).toBe(false);
  });
});

describe("attachAdtCanvasPointers", () => {
  function fakeCanvas() {
    const listeners: Record<string, EventListener> = {};
    const canvas = {
      width: 100,
      height: 100,
      tabIndex: -1,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      addEventListener: (type: string, handler: EventListener) => {
        listeners[type] = handler;
      },
      removeEventListener: vi.fn(),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      focus: vi.fn(),
    } as unknown as HTMLCanvasElement & { tabIndex: number };
    return { canvas, listeners };
  }

  it("captures the primary pointer on down and releases on up", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const adt = {
      pick,
      markAsDirty: vi.fn(),
      _checkUpdate: vi.fn(),
      useInvalidateRectOptimization: false,
    } as unknown as AdvancedDynamicTexture;
    const detach = attachAdtCanvasPointers(canvas, adt);
    listeners.pointerdown?.(
      {
        type: "pointerdown",
        pointerId: 7,
        clientX: 50,
        clientY: 25,
        preventDefault: vi.fn(),
      } as unknown as Event,
    );
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    expect(canvas.focus).toHaveBeenCalled();
    expect(pick).toHaveBeenCalled();
    listeners.pointerup?.(
      {
        type: "pointerup",
        pointerId: 7,
        clientX: 50,
        clientY: 25,
        preventDefault: vi.fn(),
      } as unknown as Event,
    );
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
    detach();
  });

  it("isolates pick errors instead of throwing into the pointer handler", () => {
    const { canvas, listeners } = fakeCanvas();
    const onPickError = vi.fn();
    const adt = {
      pick: () => {
        throw new Error("control is disposed");
      },
      markAsDirty: vi.fn(),
      _checkUpdate: vi.fn(),
      useInvalidateRectOptimization: false,
    } as unknown as AdvancedDynamicTexture;
    attachAdtCanvasPointers(canvas, adt, undefined, { onPickError });
    expect(() =>
      listeners.pointerdown?.({
        type: "pointerdown",
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      } as unknown as Event),
    ).not.toThrow();
    expect(onPickError).toHaveBeenCalled();
  });

  it("forwards wheel and keyboard events to the ADT", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const processKeyboard = vi.fn();
    const adt = {
      pick,
      processKeyboard,
      markAsDirty: vi.fn(),
      _checkUpdate: vi.fn(),
      useInvalidateRectOptimization: false,
    } as unknown as AdvancedDynamicTexture;
    attachAdtCanvasPointers(canvas, adt);
    const preventDefault = vi.fn();
    listeners.wheel?.({
      type: "wheel",
      clientX: 10,
      clientY: 10,
      deltaY: 40,
      preventDefault,
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalled();
    expect(pick).toHaveBeenCalled();
    listeners.keydown?.({
      type: "keydown",
      key: "a",
      preventDefault: vi.fn(),
    } as unknown as Event);
    expect(processKeyboard).toHaveBeenCalled();
  });

  it("prepares a full ADT redraw before pick so empty-area hits do not blit a cleared backing store", () => {
    const { canvas, listeners } = fakeCanvas();
    let invalidateRect = true;
    let clipBroken = false;
    let backing: { id: string } = { id: "painted" };
    const order: string[] = [];
    const adt = {
      pick: vi.fn(() => {
        order.push(`pick:${invalidateRect ? "partial" : "full"}`);
        if (invalidateRect) {
          clipBroken = true;
          backing = { id: "empty" };
        }
      }),
      _checkUpdate: vi.fn(() => {
        order.push(`check:${invalidateRect ? "partial" : "full"}`);
        if (clipBroken) {
          backing = { id: "empty" };
          return;
        }
        if (!invalidateRect) backing = { id: "painted" };
      }),
      markAsDirty: vi.fn(() => {
        order.push("dirty");
      }),
      getContext: () => ({ canvas: backing }),
      getSize: () => ({ width: 8, height: 8 }),
    } as unknown as AdvancedDynamicTexture;
    Object.defineProperty(adt, "useInvalidateRectOptimization", {
      get: () => invalidateRect,
      set: (value: boolean) => {
        invalidateRect = value;
        order.push(`opt:${value}`);
      },
    });
    const drawImage = vi.fn();
    const dest = {
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage,
      }),
      width: 8,
      height: 8,
    } as unknown as HTMLCanvasElement;
    attachAdtCanvasPointers(canvas, adt, () => presentAdtToCanvas(adt, dest));
    listeners.pointerdown?.({
      type: "pointerdown",
      pointerId: 1,
      isPrimary: true,
      clientX: 2,
      clientY: 2,
      preventDefault: vi.fn(),
    } as unknown as Event);
    const pickAt = order.indexOf("pick:full");
    expect(pickAt).toBeGreaterThanOrEqual(0);
    expect(order.slice(0, pickAt)).toContain("opt:false");
    expect(order.slice(pickAt)).toContain("check:full");
    expect(drawImage).toHaveBeenCalledWith({ id: "painted" }, 0, 0);
  });

  it("skips pick and blit when the surface is frozen", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const afterPick = vi.fn();
    const adt = { pick } as unknown as AdvancedDynamicTexture;
    attachAdtCanvasPointers(canvas, adt, afterPick, { isFrozen: () => true });
    listeners.pointerdown?.({
      type: "pointerdown",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
      preventDefault: vi.fn(),
    } as unknown as Event);
    expect(pick).not.toHaveBeenCalled();
    expect(afterPick).not.toHaveBeenCalled();
    expect(canvas.setPointerCapture).not.toHaveBeenCalled();
  });

  it("stops pointer events from bubbling off the live canvas", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const adt = {
      pick,
      markAsDirty: vi.fn(),
      _checkUpdate: vi.fn(),
      useInvalidateRectOptimization: false,
    } as unknown as AdvancedDynamicTexture;
    attachAdtCanvasPointers(canvas, adt);
    const stopPropagation = vi.fn();
    listeners.pointerdown?.({
      type: "pointerdown",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
      preventDefault: vi.fn(),
      stopPropagation,
    } as unknown as Event);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("ignores non-primary pointerdown and only tracks the captured pointer", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const adt = {
      pick,
      markAsDirty: vi.fn(),
      _checkUpdate: vi.fn(),
      useInvalidateRectOptimization: false,
    } as unknown as AdvancedDynamicTexture;
    attachAdtCanvasPointers(canvas, adt);
    listeners.pointerdown?.(
      {
        type: "pointerdown",
        pointerId: 2,
        isPrimary: false,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      } as unknown as Event,
    );
    expect(canvas.setPointerCapture).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
    listeners.pointerdown?.(
      {
        type: "pointerdown",
        pointerId: 1,
        isPrimary: true,
        clientX: 20,
        clientY: 20,
        preventDefault: vi.fn(),
      } as unknown as Event,
    );
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(pick).toHaveBeenCalledTimes(1);
    listeners.pointermove?.(
      {
        type: "pointermove",
        pointerId: 9,
        isPrimary: false,
        clientX: 40,
        clientY: 40,
        preventDefault: vi.fn(),
      } as unknown as Event,
    );
    expect(pick).toHaveBeenCalledTimes(1);
    listeners.pointermove?.(
      {
        type: "pointermove",
        pointerId: 1,
        isPrimary: true,
        clientX: 30,
        clientY: 30,
        preventDefault: vi.fn(),
      } as unknown as Event,
    );
    expect(pick).toHaveBeenCalledTimes(2);
  });
});

describe("attachFullscreenGuiPointerMoves", () => {
  function fakeCanvas() {
    const listeners: Record<string, EventListener> = {};
    const canvas = {
      width: 100,
      height: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      addEventListener: (type: string, handler: EventListener) => {
        listeners[type] = handler;
      },
      removeEventListener: vi.fn(),
    } as unknown as HTMLCanvasElement;
    return { canvas, listeners };
  }

  it("forwards pointermove into the Layer ADT without stopping click", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const adt = { pick } as unknown as AdvancedDynamicTexture;
    const detach = attachFullscreenGuiPointerMoves(canvas, adt);
    const stopPropagation = vi.fn();
    listeners.pointermove?.({
      type: "pointermove",
      clientX: 40,
      clientY: 20,
      stopPropagation,
      preventDefault: vi.fn(),
    } as unknown as Event);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(listeners.pointerdown).toBeUndefined();
    detach();
    expect(canvas.removeEventListener).toHaveBeenCalled();
  });

  it("picks off-canvas on pointerleave so hover exit still fires", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const adt = { pick } as unknown as AdvancedDynamicTexture;
    attachFullscreenGuiPointerMoves(canvas, adt);
    listeners.pointerleave?.({
      type: "pointerleave",
      clientX: 40,
      clientY: 20,
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    } as unknown as Event);
    expect(pick).toHaveBeenCalledTimes(1);
  });
});
