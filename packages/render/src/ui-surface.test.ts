import { describe, expect, it, vi } from "vitest";
import type { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { isHardUiPresentFailure, presentAdtToCanvas, blitIfUnfrozen } from "./ui-surface";

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
    expect(isHardUiPresentFailure(new Error("standalone ADT failed"))).toBe(true);
  });

  it("treats a zero-size ADT blit as a transient skip", () => {
    expect(isHardUiPresentFailure(new Error("ADT blit size is 0"))).toBe(false);
  });
});
