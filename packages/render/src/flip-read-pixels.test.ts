import { describe, expect, it } from "vitest";
import { flipReadPixelsRgba } from "./flip-read-pixels";

describe("flipReadPixelsRgba", () => {
  it("puts the WebGL bottom row at the 2D canvas top", () => {
    const width = 2;
    const height = 3;
    const gpu = new Uint8Array(width * height * 4);
    // Bottom-left origin: row 0 is the GPU bottom (red), row 2 is the GPU top (blue).
    gpu.set([255, 0, 0, 255, 255, 0, 0, 255], 0);
    gpu.set([0, 255, 0, 255, 0, 255, 0, 255], 8);
    gpu.set([0, 0, 255, 255, 0, 0, 255, 255], 16);

    const flipped = flipReadPixelsRgba(gpu, width, height);

    expect([...flipped.subarray(0, 8)]).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
    expect([...flipped.subarray(8, 16)]).toEqual([0, 255, 0, 255, 0, 255, 0, 255]);
    expect([...flipped.subarray(16, 24)]).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });
});
