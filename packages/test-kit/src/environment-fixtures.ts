/** Numeric HDR cube: every texel has the supplied linear RGBA, including roughness mips. */
export function buildFloatDdsCubeFixture(
  options: {
    size?: number;
    halfFloat?: boolean;
    dx10?: boolean;
    color?: readonly [number, number, number, number];
  } = {},
): Uint8Array {
  const size = options.size ?? 2;
  const levels = Math.log2(size) + 1;
  const headerBytes = options.dx10 ? 148 : 128;
  const pixelBytes = options.halfFloat ? 8 : 16;
  let facePixels = 0;
  for (let level = 0; level < levels; level++)
    facePixels += (size / 2 ** level) ** 2;
  const bytes = new Uint8Array(headerBytes + facePixels * 6 * pixelBytes);
  const view = new DataView(bytes.buffer);
  const set = (offset: number, value: number) =>
    view.setUint32(offset, value, true);
  bytes.set([0x44, 0x44, 0x53, 0x20]);
  set(4, 124);
  set(8, 0x2100f);
  set(12, size);
  set(16, size);
  set(20, size * pixelBytes);
  set(28, levels);
  set(76, 32);
  set(80, 4);
  set(84, options.dx10 ? 0x30315844 : options.halfFloat ? 113 : 116);
  set(108, 0x401008);
  set(112, 0xfe00);
  if (options.dx10) {
    set(128, options.halfFloat ? 10 : 2);
    set(132, 3);
    set(136, 4);
    set(140, 1);
  }
  const color = options.color ?? [0.25, 0.5, 1, 1];
  for (let offset = headerBytes; offset < bytes.length; offset += pixelBytes) {
    for (let channel = 0; channel < 4; channel++) {
      const value = color[channel]!;
      if (options.halfFloat) {
        // This numeric fixture deliberately uses only exactly representable powers of two and zero.
        if (value !== 0 && !Number.isInteger(Math.log2(value)))
          throw new Error("Half-float fixture expects zero or powers of two.");
        view.setUint16(
          offset + channel * 2,
          value === 0 ? 0 : (Math.log2(value) + 15) << 10,
          true,
        );
      } else view.setFloat32(offset + channel * 4, value, true);
    }
  }
  return bytes;
}
