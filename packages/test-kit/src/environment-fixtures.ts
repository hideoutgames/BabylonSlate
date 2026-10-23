/** Numeric HDR cube: every texel has the supplied linear RGBA, including roughness mips. */
export function buildFloatDdsCubeFixture(
  options: {
    size?: number;
    halfFloat?: boolean;
    dx10?: boolean;
    color?: readonly [number, number, number, number];
  } = {},
): Uint8Array<ArrayBuffer> {
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

/** RGBE bytes of a linear color; exact for values with at most eight significant bits. */
function rgbe([r, g, b]: readonly [number, number, number]): [number, number, number, number] {
  const max = Math.max(r, g, b);
  if (max <= 0) return [0, 0, 0, 0];
  const exponent = Math.floor(Math.log2(max)) + 1;
  const scale = 256 / 2 ** exponent;
  return [Math.floor(r * scale), Math.floor(g * scale), Math.floor(b * scale), exponent + 128];
}

/** Run-length planes as Radiance writes them: runs of three or more repeat, the rest stay literal. */
function runLengthPlane(plane: number[]): number[] {
  const out: number[] = [];
  let index = 0;
  while (index < plane.length) {
    let run = 1;
    while (index + run < plane.length && run < 127 && plane[index + run] === plane[index]) run++;
    if (run >= 3) {
      out.push(128 + run, plane[index]!);
      index += run;
      continue;
    }
    const start = index;
    while (index < plane.length && index - start < 128) {
      if (index + 2 < plane.length && plane[index] === plane[index + 1] && plane[index] === plane[index + 2]) break;
      index++;
    }
    out.push(index - start, ...plane.slice(start, index));
  }
  return out;
}

/** Numeric equirectangular Radiance HDR (`-Y height +X width`); `color` takes the pixel column and row. */
export function buildRadianceHdrFixture(options: {
  width: number;
  height: number;
  color: (x: number, y: number) => readonly [number, number, number];
  runLength?: boolean;
  header?: string;
}): Uint8Array<ArrayBuffer> {
  const { width, height } = options;
  const header = options.header ?? `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n-Y ${height} +X ${width}\n`;
  const body: number[] = [];
  for (let y = 0; y < height; y++) {
    const pixels = Array.from({ length: width }, (_, x) => rgbe(options.color(x, y)));
    if (options.runLength) {
      body.push(2, 2, width >> 8, width & 0xff);
      for (let channel = 0; channel < 4; channel++)
        body.push(...runLengthPlane(pixels.map((pixel) => pixel[channel]!)));
    } else for (const pixel of pixels) body.push(...pixel);
  }
  const head = new TextEncoder().encode(header);
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return bytes;
}
