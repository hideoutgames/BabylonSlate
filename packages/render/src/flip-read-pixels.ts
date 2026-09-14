/** Copy GPU RGBA rows to Canvas2D / PNG, flipping only bottom-left origins. */
export function flipReadPixelsRgba(
  buffer: ArrayBuffer | ArrayBufferView,
  width: number,
  height: number,
  originBottomLeft = true,
): Uint8ClampedArray {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const byteLength = width * height * 4;
  if (bytes.byteLength < byteLength || width <= 0 || height <= 0) {
    return new Uint8ClampedArray(Math.max(0, byteLength));
  }
  const row = width * 4;
  const flipped = new Uint8ClampedArray(byteLength);
  for (let y = 0; y < height; y++) {
    const src = y * row;
    flipped.set(bytes.subarray(src, src + row), (originBottomLeft ? height - 1 - y : y) * row);
  }
  return flipped;
}
