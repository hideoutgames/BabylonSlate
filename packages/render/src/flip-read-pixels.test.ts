import type { BaseTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRttCanvasBlitter, flipReadPixelsRgba } from "./flip-read-pixels";

describe("flipReadPixelsRgba", () => {
  it("copies only the readback view's byte range without changing the allocation", () => {
    const allocation = new Uint8Array([
      99, 99, 99, 99,
      10, 20, 30, 255,
      40, 50, 60, 255,
      88, 88, 88, 88,
    ]);
    const view = new DataView(allocation.buffer, 4, 8);
    const pixels = flipReadPixelsRgba(view, 1, 2);
    expect([...pixels]).toEqual([40, 50, 60, 255, 10, 20, 30, 255]);
    pixels[0] = 0;
    expect(allocation[8]).toBe(40);
  });

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

  it("flips into a supplied array of the frame size and blanks it for a short readback", () => {
    const out = new Uint8ClampedArray(8).fill(9);
    const gpu = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99);
    expect(flipReadPixelsRgba(gpu, 1, 2, out)).toBe(out);
    expect([...out]).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
    expect(flipReadPixelsRgba(new Uint8Array(0), 1, 2, out)).toBe(out);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("createRttCanvasBlitter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Mirror Babylon's WebGPU readback into a caller buffer: copy 256-byte-aligned rows, then repack them in place. */
  function webGpuTexture(width: number, height: number, rows: (y: number) => number[]) {
    return {
      getSize: () => ({ width, height }),
      readPixels: (_face: number, _level: number, buffer: Uint8Array) => {
        const aligned = Math.ceil((width * 4) / 256) * 256;
        const padded = new Uint8Array(aligned * height);
        for (let y = 0; y < height; y++) padded.set(rows(y), y * aligned);
        const data = new Uint8Array(buffer.buffer);
        data.set(padded.subarray(0, Math.min(data.byteLength, padded.byteLength)));
        for (let y = 1; y < height; y++) data.copyWithin(y * width * 4, y * aligned, y * aligned + width * 4);
        return Promise.resolve(new Uint8Array(data.buffer, 0, width * height * 4));
      },
    } as unknown as BaseTexture;
  }

  it("keeps every padded WebGPU row and draws the returned view flipped", async () => {
    vi.stubGlobal("ImageData", class {
      constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    });
    const width = 3;
    const height = 4;
    const rowColor = (y: number) => Array.from({ length: width }, () => [y + 1, 0, 0, 255]).flat();
    const drawn: ImageData[] = [];
    const ctx = { putImageData: (image: ImageData) => drawn.push(image) } as unknown as CanvasRenderingContext2D;
    const blitter = createRttCanvasBlitter();
    const pixels = await blitter.read(webGpuTexture(width, height, rowColor));
    blitter.put(ctx, pixels!, width, height);
    const firstPixels = [0, 1, 2, 3].map((y) => drawn[0]!.data[y * width * 4]);
    expect(firstPixels).toEqual([4, 3, 2, 1]);
  });
});
