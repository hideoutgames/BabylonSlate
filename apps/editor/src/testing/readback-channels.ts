/**
 * WebGPU swap chains are bgra8unorm on most platforms, so canvas readback
 * arrives in BGRA order while WebGL2 always returns RGBA. Normalize engine
 * readPixels output to RGBA before comparing pixels across backends.
 */
export function readbackChannelOrder(
  isWebGPU: boolean,
): readonly [number, number, number, number] {
  if (!isWebGPU) return [0, 1, 2, 3];
  const gpu = (
    navigator as unknown as {
      gpu?: { getPreferredCanvasFormat(): "rgba8unorm" | "bgra8unorm" };
    }
  ).gpu;
  return gpu?.getPreferredCanvasFormat() === "bgra8unorm"
    ? [2, 1, 0, 3]
    : [0, 1, 2, 3];
}

export function toRgbaPixels(
  bytes: Uint8Array,
  order: readonly [number, number, number, number],
): number[] {
  const out = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    out[i] = bytes[i + order[0]]!;
    out[i + 1] = bytes[i + order[1]]!;
    out[i + 2] = bytes[i + order[2]]!;
    out[i + 3] = bytes[i + order[3]]!;
  }
  return out;
}
