import { describe, expect, it, vi } from "vitest";
import type { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { presentAdtToCanvas } from "./ui-surface";

function fakeAdt(source: { canvas: unknown } | null): AdvancedDynamicTexture {
  return {
    _checkUpdate: vi.fn(),
    getContext: () => source,
    getSize: () => ({ width: 8, height: 8 }),
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
});
