import { describe, expect, it, vi } from "vitest";
import type { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import {
  attachAdtCanvasPointers,
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
    const adt = { pick } as unknown as AdvancedDynamicTexture;
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
    const adt = { pick, processKeyboard } as unknown as AdvancedDynamicTexture;
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

  it("ignores non-primary pointerdown and only tracks the captured pointer", () => {
    const { canvas, listeners } = fakeCanvas();
    const pick = vi.fn();
    const adt = { pick } as unknown as AdvancedDynamicTexture;
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
