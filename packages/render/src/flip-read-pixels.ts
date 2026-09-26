import type { BaseTexture } from "@babylonjs/core";

/**
 * Copy Babylon RGBA render targets to Canvas2D / PNG. Both backends use flipped RTT rows.
 * An `out` array of exactly `width * height * 4` bytes is filled and returned instead of a new one.
 */
export function flipReadPixelsRgba(
  buffer: ArrayBuffer | ArrayBufferView,
  width: number,
  height: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const byteLength = width * height * 4;
  const target = out?.length === byteLength ? out : null;
  if (bytes.byteLength < byteLength || width <= 0 || height <= 0) {
    return target ? target.fill(0) : new Uint8ClampedArray(Math.max(0, byteLength));
  }
  const row = width * 4;
  const flipped = target ?? new Uint8ClampedArray(byteLength);
  for (let y = 0; y < height; y++) {
    const src = y * row;
    flipped.set(bytes.subarray(src, src + row), (height - 1 - y) * row);
  }
  return flipped;
}

/**
 * Reused readback and ImageData storage for presenting one RGBA8 render
 * target on a 2D canvas every frame. Both are reallocated only when the
 * target size changes; draw each readback before starting the next one.
 */
export function createRttCanvasBlitter() {
  let readback: Uint8Array | null = null;
  let readbackWidth = 0;
  let readbackHeight = 0;
  let image: ImageData | null = null;
  return {
    /**
     * Read the target into the reused buffer. Use the resolved view, not the
     * buffer: WebGPU removes its row padding into a shorter prefix view.
     */
    read(texture: BaseTexture): Promise<ArrayBufferView> | null {
      const { width, height } = texture.getSize();
      if (!readback || readbackWidth !== width || readbackHeight !== height) {
        // WebGPU copies rows padded to 256 bytes into the caller's buffer
        // before repacking them in place; WebGL accepts the larger buffer.
        readback = new Uint8Array(Math.ceil((width * 4) / 256) * 256 * height);
        readbackWidth = width;
        readbackHeight = height;
      }
      return texture.readPixels(0, 0, readback);
    },
    /** Flip a readback into the reused ImageData and draw it at the canvas origin. */
    put(
      ctx: CanvasRenderingContext2D,
      pixels: ArrayBufferView,
      width: number,
      height: number,
    ): void {
      if (image?.width !== width || image.height !== height) {
        image = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
      }
      flipReadPixelsRgba(pixels, width, height, image.data);
      ctx.putImageData(image, 0, 0);
    },
  };
}
